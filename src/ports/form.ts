// PORT — the SettlementForm strategy + closed-union resolution (§4.3).
//
// `SettlementForm` is a CLOSED string-literal union at the API edge
// (SettlementFormId = 'plain'|'htlc'), and the registry is keyed by that union.
// New forms widen the union as an ADDITIVE minor (no HONOR_API_VERSION bump); the
// registry REJECTS unknown form strings at runtime. This buys consumers
// exhaustive switches + type-safety while keeping plug-in registration.

import type {
  AcceptedQuote,
  HonorVerdict,
  SettlementFormId,
  WaitReason,
} from "../spec/index.js";
import type { ChainSource, RawSettlementCandidate } from "./chain.js";
import type { KeyCustody } from "./custody.js";
import type { GateMode } from "./store.js";

/**
 * HonorConfig: the tuning constants every form / the scorer reads (§4). Frozen
 * in the deps bag. CLAIM_MARGIN is DERIVED and startup-asserted (D1), never
 * hardcoded.
 */
export interface HonorConfig {
  readonly confirmationDepth: number; // CONFIRMATION_DEPTH (e.g. 6)
  readonly maxReorgDepth: number; // MAX_REORG_DEPTH (e.g. 12)
  readonly claimMargin: number; // = maxReorgDepth + confirmationDepth + 1 (D1)
  readonly maxRecheckWindow: number; // R6 late-honor window, seconds
  readonly payerBinding: "consent" | "source"; // R5 default mode (D3)
  readonly requirePayerFunded: boolean; // opt into SOURCE binding (D3)
}

export interface ScoringCtx {
  readonly quote: AcceptedQuote;
  readonly tip: number;
  readonly now: number;
  readonly config: HonorConfig;
  readonly chain: ChainSource;
  readonly keys: KeyCustody;
}

/** Outcome of a form's optional pre-honor side-effect (HTLC phase-A). */
export type PrepareResult =
  | { kind: "ready" } // proceed to gate txn
  | { kind: "claim_submitted"; claimTxId: string } // HTLC phase-A done → status, wait next tick (R3)
  | { kind: "wait"; reason: WaitReason };

export interface SettlementForm {
  /** 'plain' | 'htlc' — additive widening per minor. */
  readonly id: SettlementFormId;

  discover(ctx: ScoringCtx): Promise<RawSettlementCandidate[]>;
  /**
   * Pure-ish: map raw candidates → ONE HonorVerdict against R1–R7. MUST emit
   * only closed WaitReason/DeclineReason members. NO locking, NO delivery.
   */
  score(ctx: ScoringCtx, raw: RawSettlementCandidate[]): Promise<HonorVerdict>;
  /** Optional pre-honor side-effect BEFORE the gate (HTLC phase-A). Plain = no-op. */
  prepare?(
    ctx: ScoringCtx,
    v: Extract<HonorVerdict, { decision: "honor" }>,
  ): Promise<PrepareResult>;
  /** Which runHonorTxn mode this form uses at the gate (F13). */
  gateMode(): GateMode;
}

export interface SettlementFormRegistry {
  /** throws malformed_quote for an unregistered id. */
  get(id: SettlementFormId): SettlementForm;
  has(id: string): boolean;
}
