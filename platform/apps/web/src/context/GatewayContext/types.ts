import type { GatewayClient } from "../../api/gateway";
import type {
  AuthStateAgent,
  GatewayEventFrame,
  GatewayHelloOk,
  GatewayRequest,
  PrepareError,
  RuntimeScope,
} from "../../api/ws-types";

export type GatewayStatus =
  | "resolving_scope"
  | "connecting"
  | "connected"
  | "scope_missing"
  | "error";

export type GatewayDiagnostics = {
  connectAttempts: number;
  lastOpenAt: number | null;
  lastConnectSentAt: number | null;
  lastHelloAt: number | null;
  lastCloseCode: number | null;
  lastCloseReason: string | null;
  lastFrameType: string | null;
  lastFrameAt: number | null;
  /**
   * Timestamp of the most recent close event whose code was NOT 1000
   * (normal closure). Null on first mount and after a clean close.
   * Consumers use this to detect a fresh abnormal-close event and trigger
   * one-shot UI like the diagnostic banner.
   */
  lastAbnormalCloseAt: number | null;
};

export type GatewayContextValue = {
  client: GatewayClient | null;
  connected: boolean;
  status: GatewayStatus;
  hello: GatewayHelloOk | null;
  diagnostics: GatewayDiagnostics;
  /** Broker -> gateway dependency readiness from /health polling. */
  gatewayReady: boolean | null;
  /** The resolved runtime scope for this connection. Null until scope resolves. */
  scope: RuntimeScope | null;
  /** The agent/model currently targeted by the websocket scope. */
  target: AuthStateAgent | null;
  /** Structured error returned by the most recent prepareRuntime call, if any. */
  prepareError: PrepareError | null;
  /** Clear the current prepareError (e.g. after the user fixes the config). */
  clearPrepareError: () => void;
  connect: () => Promise<void>;
  disconnect: () => void;
  request: GatewayRequest;
  addEventListener: (handler: (evt: GatewayEventFrame) => void) => () => void;
};

export const initialGatewayDiagnostics: GatewayDiagnostics = {
  connectAttempts: 0,
  lastOpenAt: null,
  lastConnectSentAt: null,
  lastHelloAt: null,
  lastCloseCode: null,
  lastCloseReason: null,
  lastFrameType: null,
  lastFrameAt: null,
  lastAbnormalCloseAt: null,
};
