// SERVICE — the Stage-E ERGONOMIC FAÇADE (§ Stage-E).
//
// A THIN convenience layer ON TOP of the frozen core. It does NOT change core
// behaviour or the safety guarantees (F3/F8/F10/F11, atomic gate+deliver): every
// honor decision still flows through the SAME `createHonorEngine` + the SAME §5
// write-ahead gate txn. The façade only collapses the common-case wiring and the
// observe→honor polling loop a consumer would otherwise hand-write.
//
//   createHonorService(config) — construct SqliteStore(db) (runs its migration —
//     adds ONLY honor's own tables), IndexerChainSource(indexer,node),
//     WalletdVerifier(walletd,token), KeystoreKeyCustody(walletd), register the
//     plain + htlc forms, and createHonorEngine(...). Returns a HonorService that
//     ALSO exposes the underlying engine + ports (never hidden — advanced use).
//
//   service.onPaid(quote, deliver) — register the quote then drive the
//     observe→honor loop on a timer (pollIntervalMs): each tick markObserved (when
//     a candidate is on-chain) + honor(key, deliver). Resolves when honored
//     (deliver ran inside the atomic txn, exactly once) or when terminally declined
//     / expired; stops the timer on a terminal outcome. Retryable faults
//     (chain_fault, delivery_failed, wait verdicts) retry on the next tick.
//
// F8 carry-over: `onPaid`'s `deliver` is `(ctx: DeliverContext<M>) =>
// EnforceDeliverReturn<M, R>` — the SAME enforcement the engine's `honor` uses, so
// an async deliver under a sync (SQLite) store is a COMPILE error through the
// façade too. M is pinned by the store the service was built with.

import type { Database } from "better-sqlite3";
import {
  IndexerChainSource,
  KeystoreKeyCustody,
  SqliteStore,
  WalletdVerifier,
  type IndexerChainSourceOpts,
  type JsonRpc,
} from "../adapters/index.js";
import { createFormRegistry, createHonorEngine } from "../core/index.js";
import type { TypedHonorEngine } from "../core/index.js";
import { builtinForms } from "../forms/index.js";
import { HonorError } from "../spec/index.js";
import type {
  AcceptedQuote,
  DeliverContext,
  EnforceDeliverReturn,
  HonorKey,
  HonorOutcome,
  TxnModel,
} from "../spec/index.js";
import type {
  AddressDeriver,
  ChainSource,
  Clock,
  HonorConfig,
  KeyCustody,
  Logger,
} from "../ports/index.js";
import { httpJsonRpc } from "./http-rpc.js";

// ---------------------------------------------------------------------------
// locked safe defaults (D1/D3). CLAIM_MARGIN is DERIVED + startup-asserted by the
// engine; we surface only the two knobs (depths) and the window/binding defaults.
// ---------------------------------------------------------------------------

const DEFAULT_CONFIRMATION_DEPTH = 6; // CONFIRMATION_DEPTH
const DEFAULT_MAX_REORG_DEPTH = 12; // MAX_REORG_DEPTH → CLAIM_MARGIN = 12+6+1 = 19
const DEFAULT_MAX_RECHECK_WINDOW = 3600; // R6 late-honor window, seconds
const DEFAULT_PAYER_BINDING: "consent" | "source" = "consent"; // D3
const DEFAULT_POLL_INTERVAL_MS = 5_000;

/** A wall-clock real-time clock (the default when none is injected). */
const systemClock: Clock = { now: () => Math.floor(Date.now() / 1000) };

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

/** Either a URL the façade turns into an HTTP `JsonRpc`, or a ready transport. */
export type RpcEndpoint = string | JsonRpc;

export interface HonorServiceConfig {
  /** exfer-walletd JSON-RPC endpoint (ACCEPT bridge + R2/M3 custody). */
  readonly walletd: RpcEndpoint;
  /** exfer-indexer JSON-RPC endpoint (Stage-1 settlement reverse index). */
  readonly indexer: RpcEndpoint;
  /** exfer node JSON-RPC endpoint (tip / depth / prevouts). */
  readonly node: RpcEndpoint;
  /** the consumer's better-sqlite3 connection — the SAME one its goods tables
   *  live on (F12). SqliteStore.init() adds ONLY honor's own tables. */
  readonly db: Database;
  /** the payee identity (informational hook for the consumer; the binding payee is
   *  carried per-quote in `AcceptedQuote.payeePubkey`). */
  readonly payee?: string;
  /** optional bearer token forwarded to the walletd transport. */
  readonly token?: string;

  // -- optional tuning; default to the locked safe defaults. -----------------
  readonly claimMargin?: number;
  readonly confirmationDepth?: number;
  readonly maxReorgDepth?: number;
  readonly maxRecheckWindow?: number;
  readonly payerBinding?: "consent" | "source";
  readonly requirePayerFunded?: boolean;
  readonly pollIntervalMs?: number;
  /** the REAL chain address derivation (R4 binding: `scriptHex ===
   *  domainHashAddr(payeePubkey)`). Production consumers MUST inject this —
   *  without it the forms fall back to the library's structural placeholder,
   *  which never matches a real on-chain script (every candidate declines
   *  with `address_mismatch`). Forwarded to both the forms (HonorConfig) and
   *  the walletd KeyCustody adapter so the two agree on one derivation. */
  readonly addressDeriver?: AddressDeriver;

  // -- advanced port injection (testing / custom transports). DO NOT hide. ----
  /** override the ChainSource (e.g. a fake in tests). */
  readonly chainSource?: ChainSource;
  /** override the KeyCustody port (e.g. a fake in tests). */
  readonly keyCustody?: KeyCustody;
  /** override the verifier used by `accept` (e.g. a fake in tests). */
  readonly verifier?: WalletdVerifier;
  /** override the injectable clock (determinism / conformance vectors). */
  readonly clock?: Clock;
  /** optional structured logger. */
  readonly logger?: Logger;
  /** optional claim submitter wired into the ChainSource for HTLC honoring. */
  readonly claimSubmit?: IndexerChainSourceOpts["claimSubmit"];
}

// ---------------------------------------------------------------------------
// onPaid loop typing
// ---------------------------------------------------------------------------

/** The terminal resolution of an `onPaid` loop. `honored` ⇒ deliver ran exactly
 *  once inside the atomic gate txn; `declined`/`expired` ⇒ a terminal R1–R7
 *  outcome (the timer is stopped). */
export type OnPaidResult =
  | { readonly status: "honored"; readonly outcome: HonorOutcome }
  | {
      readonly status: "declined";
      readonly reason: string;
      readonly outcome: HonorOutcome;
    }
  | { readonly status: "cancelled" };

/** Handle returned by `onPaid`: await `done` for the terminal outcome, or `cancel`
 *  to stop the timer early (resolves `done` with `{ status: 'cancelled' }`). */
export interface OnPaidHandle {
  readonly key: HonorKey;
  /** resolves on a terminal outcome (honored / declined / expired / cancelled);
   *  rejects only on an UNEXPECTED infra fault that is not retryable. */
  readonly done: Promise<OnPaidResult>;
  /** stop the loop; the next `done` resolves `{ status: 'cancelled' }`. */
  cancel(): void;
}

export interface OnPaidOpts {
  /** override the service-wide poll interval for this quote. */
  readonly pollIntervalMs?: number;
  /** §5.6: re-throw a consumer delivery error instead of retrying it. Default
   *  false (a delivery_failed is treated as retryable and retried next tick). */
  readonly rethrowDeliveryErrors?: boolean;
}

// ---------------------------------------------------------------------------
// the service
// ---------------------------------------------------------------------------

/**
 * The ergonomic façade. Wraps a pinned engine (M from the SQLite store ⇒ 'sync')
 * and exposes both the high-level `onPaid` loop AND the underlying engine + ports
 * for advanced use.
 */
export class HonorService<M extends TxnModel> {
  constructor(
    /** the pinned engine — exposed for advanced use (NOT hidden). */
    readonly engine: TypedHonorEngine<M>,
    /** the underlying ports — exposed for advanced use (NOT hidden). */
    readonly ports: {
      readonly store: SqliteStore;
      readonly chain: ChainSource;
      readonly keys: KeyCustody;
      readonly clock: Clock;
      readonly verifier: WalletdVerifier;
      readonly config: HonorConfig;
    },
    private readonly defaultPollIntervalMs: number,
  ) {}

  /** Direct access to the ACCEPT bridge (advanced; `onPaid` takes an already-
   *  accepted quote). */
  get verifier(): WalletdVerifier {
    return this.ports.verifier;
  }

  /**
   * Register `quote` (R6 write-ahead) then drive the observe→honor loop on a timer.
   * Each tick: markObserved (when a candidate is on-chain) + honor(key, deliver).
   * Resolves when honored (deliver ran inside the atomic gate txn, exactly once) or
   * when terminally declined / expired; stops the timer on a terminal outcome.
   * Retryable faults (chain_fault, delivery_failed, wait verdicts) retry next tick.
   *
   * `deliver` is the consumer's sync-model `(ctx) => void` run INSIDE the honor txn
   * — F8 type-safety is preserved end-to-end: an async deliver is a compile error.
   */
  onPaid<R>(
    quote: AcceptedQuote,
    deliver: (ctx: DeliverContext<M>) => EnforceDeliverReturn<M, R>,
    opts?: OnPaidOpts,
  ): OnPaidHandle {
    const key: HonorKey = {
      signerPubkey: quote.signerPubkey,
      quoteId: quote.quoteId,
    };
    const intervalMs = opts?.pollIntervalMs ?? this.defaultPollIntervalMs;
    const rethrow = opts?.rethrowDeliveryErrors ?? false;

    let timer: ReturnType<typeof setInterval> | null = null;
    let settled = false;
    let ticking = false;

    let resolve!: (r: OnPaidResult) => void;
    let reject!: (e: unknown) => void;
    const done = new Promise<OnPaidResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    const stop = (): void => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };

    const finish = (r: OnPaidResult): void => {
      if (settled) return;
      settled = true;
      stop();
      resolve(r);
    };

    const fail = (e: unknown): void => {
      if (settled) return;
      settled = true;
      stop();
      reject(e);
    };

    // ONE tick of the loop. Re-entrancy guarded: a slow async honor must not
    // overlap the next interval fire.
    const tick = async (): Promise<void> => {
      if (settled || ticking) return;
      ticking = true;
      try {
        const now = this.ports.clock.now();

        // Observe latch: idempotent, only bites while now < expiresAt. Safe every
        // tick. We only need a candidate to be on-chain to count as observed; the
        // engine's markObserved itself enforces the within-window rule, so calling
        // it unconditionally each tick is correct and cheap.
        await this.engine.markObserved(key, now);

        const outcome = await this.engine.honor(key, deliver, {
          rethrowDeliveryErrors: rethrow,
        });

        if (outcome.status === "honored") {
          finish({ status: "honored", outcome });
          return;
        }
        if (outcome.status === "delivery_failed") {
          // F11: gate rolled back clean; retryable → retry next tick.
          return;
        }
        // not_ready{verdict}: wait ⇒ retry; decline ⇒ terminal. A residual
        // 'honor' verdict inside not_ready is not a terminal answer (the gate did
        // not commit) — retry next tick.
        const verdict = outcome.verdict;
        if (verdict.decision === "decline") {
          // terminal: expired_unobserved / amount_mismatch / … Stop the timer.
          finish({ status: "declined", reason: verdict.reason, outcome });
          return;
        }
        // wait (or a non-committing honor verdict) ⇒ retry next tick.
      } catch (e) {
        // A retryable infra fault (chain_fault / keystore_fault / db_fault /
        // indexer_fault) should NOT kill the loop — retry next tick. A terminal
        // contract fault (malformed_quote / api_version_mismatch / store_topology /
        // contract_violation) or a re-thrown delivery error is surfaced.
        if (isRetryableFault(e)) {
          return; // retry next tick
        }
        fail(e);
      } finally {
        ticking = false;
      }
    };

    // Register (R6 write-ahead) then start ticking. Registration faults are
    // surfaced the same way as a tick fault (retryable infra → keep trying,
    // terminal → reject).
    void (async () => {
      try {
        await this.engine.register(quote);
      } catch (e) {
        if (!isRetryableFault(e)) {
          fail(e);
          return;
        }
        // a transient register fault: fall through and let the loop retry honor;
        // register is idempotent so a later successful tick re-registers.
      }
      if (settled) return;
      // fire one tick immediately, then on the interval.
      timer = setInterval(() => {
        void tick();
      }, intervalMs);
      // best-effort: also kick a first tick without waiting a full interval.
      void tick();
    })();

    return {
      key,
      done,
      cancel: () => finish({ status: "cancelled" }),
    };
  }
}

/** Retryable faults retry on the next tick; everything else is terminal. */
function isRetryableFault(e: unknown): boolean {
  if (e instanceof HonorError) {
    return (
      e.code === "chain_fault" ||
      e.code === "keystore_fault" ||
      e.code === "db_fault" ||
      e.code === "indexer_fault"
    );
  }
  return false;
}

// ---------------------------------------------------------------------------
// constructor
// ---------------------------------------------------------------------------

function toRpc(endpoint: RpcEndpoint, token?: string): JsonRpc {
  return typeof endpoint === "string" ? httpJsonRpc(endpoint, token) : endpoint;
}

/**
 * Construct a `HonorService` over a SQLite gate. Wires the five reference ports +
 * the plain/htlc forms + the engine; the result is a `Store<'sync'>`-pinned
 * service whose `onPaid.deliver` MUST be synchronous (F8). The store's migration
 * runs at construction (adds ONLY honor's own tables to the consumer's DB).
 *
 * @example
 *   const service = await createHonorService({
 *     walletd: "http://localhost:9100",
 *     indexer: "http://localhost:9200",
 *     node:    "http://localhost:9300",
 *     db,                         // your better-sqlite3 handle
 *     payee:   myPayeePubkey,
 *   });
 *   service.onPaid(acceptedQuote, (ctx) => writeGoods(ctx)); // sync deliver
 */
export async function createHonorService(
  config: HonorServiceConfig,
): Promise<HonorService<"sync">> {
  const token = config.token;

  // The single shared gate connection (F12). init() runs the SQLite migration —
  // it adds ONLY honor's own tables (CREATE TABLE IF NOT EXISTS); the consumer's
  // goods tables on the same connection are untouched.
  const store = new SqliteStore(config.db);
  await store.init();

  // ChainSource: indexer Stage-1 + node JSON-RPC (+ optional claim submitter).
  const chain: ChainSource =
    config.chainSource ??
    new IndexerChainSource({
      indexer: toRpc(config.indexer),
      node: toRpc(config.node),
      claimSubmit: config.claimSubmit,
    });

  // KeyCustody: R2/M3 payee custody test-sign over walletd. Shares the SAME
  // address derivation as the forms' R4 binding.
  const keys: KeyCustody =
    config.keyCustody ??
    new KeystoreKeyCustody({
      walletd: toRpc(config.walletd, token),
      addressDeriver: config.addressDeriver,
    });

  // ACCEPT bridge (advanced; `onPaid` takes an already-accepted quote).
  const verifier = config.verifier ?? new WalletdVerifier(toRpc(config.walletd, token));

  const clock: Clock = config.clock ?? systemClock;

  // Locked safe defaults; CLAIM_MARGIN is DERIVED + startup-asserted by the engine.
  const confirmationDepth = config.confirmationDepth ?? DEFAULT_CONFIRMATION_DEPTH;
  const maxReorgDepth = config.maxReorgDepth ?? DEFAULT_MAX_REORG_DEPTH;
  const config0: HonorConfig = {
    confirmationDepth,
    maxReorgDepth,
    claimMargin: config.claimMargin ?? maxReorgDepth + confirmationDepth + 1,
    maxRecheckWindow: config.maxRecheckWindow ?? DEFAULT_MAX_RECHECK_WINDOW,
    payerBinding: config.payerBinding ?? DEFAULT_PAYER_BINDING,
    requirePayerFunded: config.requirePayerFunded ?? false,
    addressDeriver: config.addressDeriver,
  };

  // plain + htlc forms; the HTLC form reserves its claim outpoint on the SAME store.
  const forms = createFormRegistry(builtinForms({ htlcReserver: store }));

  const engine = createHonorEngine({
    store, // M inferred as 'sync'
    chain,
    keys,
    clock,
    forms,
    config: config0,
    logger: config.logger,
  });

  return new HonorService(
    engine,
    { store, chain, keys, clock, verifier, config: config0 },
    config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
  );
}
