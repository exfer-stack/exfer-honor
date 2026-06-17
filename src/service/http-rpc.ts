// SERVICE — a minimal `fetch`-based JSON-RPC transport for the ergonomic façade.
//
// The Stage-E façade takes `walletd`/`indexer`/`node` as URLs (the common case);
// it needs a `JsonRpc` transport to turn those URLs into the `JsonRpc` contract the
// reference adapters (IndexerChainSource, WalletdVerifier, KeystoreKeyCustody)
// already consume. This is the ONLY new runtime concern the façade introduces and
// it is deliberately tiny: one POST per call, JSON-RPC 2.0 envelope, throw on an
// error response so the adapters' transient-vs-terminal rules (§3.6) apply
// unchanged. A consumer who wants ret[ries/auth/keep-alive can inject its own
// `JsonRpc` instead of a URL (the façade accepts either).

import type { JsonRpc } from "../adapters/index.js";

/** Error thrown when a JSON-RPC response carries an `error` member. Carries the
 *  numeric `code` so the adapters' `isStrictDecodeFault` (-32602) etc. still bite. */
export class JsonRpcError extends Error {
  readonly code?: number;
  readonly data?: unknown;
  constructor(message: string, code?: number, data?: unknown) {
    super(message);
    this.name = "JsonRpcError";
    this.code = code;
    this.data = data;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

interface JsonRpcEnvelope<R> {
  jsonrpc?: string;
  id?: number | string | null;
  result?: R;
  error?: { code?: number; message?: string; data?: unknown };
}

/**
 * Build a `JsonRpc` transport over HTTP(S) to `url`. Each `call(method, params)`
 * POSTs a JSON-RPC 2.0 request and returns the `result`; an `error` member is
 * raised as a `JsonRpcError` (code preserved). An optional bearer `token` is sent
 * as `Authorization: Bearer <token>`.
 */
/** Transport-level retry policy. A public node behind a load balancer will
 *  occasionally drop a keep-alive socket ("other side closed", ECONNRESET) or
 *  answer 5xx while busy — these are transient and must NOT crash a long-running
 *  observe→depth→honor loop that polls every couple of seconds. We retry the
 *  fetch a few times with linear backoff. We deliberately do NOT retry a
 *  `JsonRpcError` (an application-level `error` member like -32602 strict-decode
 *  or -32601 unknown-method): those are terminal and must propagate unchanged so
 *  the adapters' transient-vs-terminal rules (§3.6) still bite. */
const RPC_MAX_ATTEMPTS = 5;
const RPC_BACKOFF_MS = 400;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function httpJsonRpc(url: string, token?: string): JsonRpc {
  let nextId = 1;
  return {
    async call<R = unknown>(method: string, params: unknown): Promise<R> {
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (token !== undefined) {
        headers.authorization = `Bearer ${token}`;
      }
      const body = JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params });
      let lastErr: unknown;
      for (let attempt = 1; attempt <= RPC_MAX_ATTEMPTS; attempt++) {
        try {
          const res = await fetch(url, { method: "POST", headers, body });
          if (!res.ok) {
            // A transport-level non-2xx is NOT a strict-decode fault. 5xx is a
            // busy/transient node — retry; a 4xx is unexpected for JSON-RPC
            // (errors arrive in the envelope) so don't spin on it.
            const e = new Error(`JSON-RPC HTTP ${res.status} from ${url} for ${method}`);
            if (res.status >= 500 && attempt < RPC_MAX_ATTEMPTS) {
              lastErr = e;
              await sleep(RPC_BACKOFF_MS * attempt);
              continue;
            }
            throw e;
          }
          const env = (await res.json()) as JsonRpcEnvelope<R>;
          if (env.error !== undefined && env.error !== null) {
            throw new JsonRpcError(
              env.error.message ?? `JSON-RPC error from ${method}`,
              env.error.code,
              env.error.data,
            );
          }
          return env.result as R;
        } catch (err) {
          // Terminal application error — propagate immediately, never retry.
          if (err instanceof JsonRpcError) throw err;
          // Network-level fault (dropped socket, DNS, connection refused): retry.
          lastErr = err;
          if (attempt < RPC_MAX_ATTEMPTS) {
            await sleep(RPC_BACKOFF_MS * attempt);
            continue;
          }
        }
      }
      throw lastErr instanceof Error
        ? lastErr
        : new Error(`JSON-RPC call ${method} to ${url} failed after ${RPC_MAX_ATTEMPTS} attempts`);
    },
  };
}
