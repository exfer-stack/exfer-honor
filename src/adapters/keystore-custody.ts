// ADAPTER — KeystoreKeyCustody: the R2/M3 payee key-custody test-sign over walletd
// (§4.4, §6.1 step 5).
//
// R2 (acceptor controls payee) is HONOR's job, NOT ACCEPT's: `quote_verify` proves
// AUTHORSHIP (the signer signed the quote), never AUTHORITY (the acceptor holds the
// payee key). The only definitive proof of key possession is a TEST-SIGN with that
// key. This adapter performs it via walletd:
//
//   1. payee_pubkey → address = domain_hash(EXFER-ADDR, payee_pubkey).
//   2. walletd `sign_message`(address, probe) — signs ONLY if the keystore holds
//      the key for that address. A successful signature ⇒ the acceptor controls the
//      payee key ⇒ `controlsPayee → true` (R2/M3 satisfied).
//
// The transient-vs-terminal rule (§3.6) is load-bearing and enforced here:
//   - A DEFINITIVE "no such key" / "key not found" ⇒ return `false` (a real
//     negative test-sign → the spine declines `payee_not_controlled`).
//   - ANY OTHER failure (transport down, keystore locked, IO error) ⇒ THROW
//     `keystore_fault` (retryable). It MUST NOT degrade to `false`, or a flaky
//     keystore would permanently strand an honorable quote.
//
// The address derivation is the SAME injectable `AddressDeriver` the scorer uses for
// R4 (§6.1 step 4), so payee-custody and payee-address binding agree on the address
// for a pubkey. A consumer wires the deriver its chain uses; the reference
// derivation is the default (a structural placeholder, not a real digest).

import { HonorError, type Hex, type PubKey, type QuoteId } from "../spec/index.js";
import type { AddressDeriver, KeyCustody } from "../ports/index.js";
import type { JsonRpc } from "./indexer-chain.js";
import { domainHashAddr } from "../forms/index.js";

interface SignMessageResult {
  signature: string;
}

export interface KeystoreKeyCustodyOpts {
  /** JSON-RPC transport to exfer-walletd (the keystore-bearing service). */
  readonly walletd: JsonRpc;
  /** EXFER-ADDR deriver — the SAME one wired into HonorConfig.addressDeriver so
   *  custody and R4 address binding agree. Defaults to the reference derivation. */
  readonly addressDeriver?: AddressDeriver;
  /** The probe message test-signed to prove key possession. A fixed, low-value,
   *  domain-tagged string is fine — the signature is never published. */
  readonly probeMessage?: string;
  /** Optional source of payee-originated HTLC preimages (R3). When the keystore
   *  cannot supply preimages, leave unset and the HTLC form waits. */
  readonly preimageLookup?: (
    quoteId: QuoteId,
    payeePubkey: PubKey,
  ) => Promise<Hex | null>;
}

const DEFAULT_PROBE = "exfer-honor:payee-custody-probe";

export class KeystoreKeyCustody implements KeyCustody {
  private readonly walletd: JsonRpc;
  private readonly deriver?: AddressDeriver;
  private readonly probe: string;
  private readonly preimageLookup?: (
    quoteId: QuoteId,
    payeePubkey: PubKey,
  ) => Promise<Hex | null>;

  constructor(opts: KeystoreKeyCustodyOpts) {
    this.walletd = opts.walletd;
    this.deriver = opts.addressDeriver;
    this.probe = opts.probeMessage ?? DEFAULT_PROBE;
    this.preimageLookup = opts.preimageLookup;
    if (this.preimageLookup !== undefined) {
      this.htlcPreimageFor = async (q: QuoteId, p: PubKey): Promise<Hex | null> => {
        // biome-ignore lint/style/noNonNullAssertion: guarded by the enclosing if.
        return this.preimageLookup!(q, p);
      };
    }
  }

  /**
   * Definitive payee-control test (R2/M3). A successful walletd test-sign with the
   * payee's key ⇒ true. A DEFINITIVE "no such key" ⇒ false. ANY other fault ⇒
   * thrown `keystore_fault` (retryable) — never a silent `false` (§3.6).
   */
  async controlsPayee(payeePubkey: PubKey): Promise<boolean> {
    const address = domainHashAddr(payeePubkey, this.deriver);
    try {
      const res = await this.walletd.call<SignMessageResult>("sign_message", {
        address,
        message: this.probe,
      });
      // A signature back ⇒ the keystore holds the key ⇒ acceptor controls payee.
      return typeof res.signature === "string" && res.signature.length > 0;
    } catch (e) {
      if (isNoSuchKey(e)) {
        // DEFINITIVE negative test-sign: the keystore does not hold this key.
        return false;
      }
      // Transient keystore/transport fault — retryable, MUST NOT degrade to false.
      throw new HonorError(
        "keystore_fault",
        "payee custody test-sign unavailable (R2/M3 transient)",
        e,
      );
    }
  }

  /** Present ONLY when a preimage lookup was wired (see constructor). */
  htlcPreimageFor?: (quoteId: QuoteId, payeePubkey: PubKey) => Promise<Hex | null>;
}

/**
 * A DEFINITIVE "the keystore does not hold this key" signal. walletd surfaces an
 * unknown-address load as a not-found error; we treat ONLY an explicit
 * no-such-key / wallet-not-found message as a definitive negative. Everything else
 * (locked keystore, transport down) is transient and re-thrown.
 */
function isNoSuchKey(e: unknown): boolean {
  const msg = (e as { message?: unknown }).message;
  if (typeof msg !== "string") return false;
  const m = msg.toLowerCase();
  return (
    m.includes("no such") ||
    m.includes("not found") ||
    m.includes("unknown address") ||
    m.includes("no wallet")
  );
}
