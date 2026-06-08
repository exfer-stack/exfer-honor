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
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
      });
      if (!res.ok) {
        // A transport-level non-2xx is NOT a strict-decode fault — surface it as a
        // plain Error so the adapters classify it as a retryable transient fault.
        throw new Error(`JSON-RPC HTTP ${res.status} from ${url} for ${method}`);
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
    },
  };
}
