// `@exfer/honor/service` barrel — the Stage-E ERGONOMIC FAÇADE.
//
// A THIN convenience layer ON TOP of the frozen core: `createHonorService(config)`
// collapses the common-case wiring (the five reference ports + the plain/htlc
// forms + the engine) to one call, and `HonorService.onPaid(quote, deliver)`
// drives the observe→honor loop on a timer. It does NOT change core behaviour or
// the safety guarantees (F3/F8/F10/F11, atomic gate+deliver); the underlying
// engine + ports stay exposed for advanced use.

export {
  createHonorService,
  HonorService,
} from "./honor-service.js";
export type {
  HonorServiceConfig,
  RpcEndpoint,
  OnPaidHandle,
  OnPaidOpts,
  OnPaidResult,
} from "./honor-service.js";
export { httpJsonRpc, JsonRpcError } from "./http-rpc.js";
