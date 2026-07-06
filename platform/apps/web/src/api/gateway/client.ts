// Gateway WebSocket client — ported from src/ui/gateway.ts
// Uses Ed25519 device identity for gateway authentication.

import {
  buildDeviceAuthPayload,
  loadOrCreateDeviceIdentity,
  signDevicePayload,
  type DeviceIdentity,
} from "../device-identity";
import type {
  ConnectParams,
  GatewayMethod,
  GatewayMethodParams,
  GatewayMethodResult,
  GatewayError,
} from "../ws-types";
import {
  gatewayFrameType,
  parseGatewayEventFrame,
  parseGatewayHelloOk,
  parseGatewayResponseFrame,
} from "../ws-types";
import {
  generateRequestId,
  loadDeviceAuthToken,
  storeDeviceAuthToken,
} from "./device-auth";
import type { GatewayClientOptions, Pending } from "./types";

export type {
  GatewayHelloOk,
  GatewayEventFrame,
  GatewayResponseFrame,
} from "../ws-types";

export class GatewayRequestError extends Error {
  readonly code: string | null;
  readonly details: unknown;

  constructor(error: GatewayError | undefined) {
    super(error?.message ?? "request failed");
    this.name = "GatewayRequestError";
    this.code = error?.code ?? null;
    this.details = error?.details;
  }
}

const CLIENT_ID = "openclaw-control-ui";
const CLIENT_MODE = "webchat";
const HEARTBEAT_INTERVAL_MS = 20_000;

export class GatewayClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private closed = false;
  private connectSent = false;
  private connectTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private connectNonce: string | null = null;
  constructor(private opts: GatewayClientOptions) {}

  start() {
    this.closed = false;
    this.connect();
  }

  stop() {
    this.closed = true;
    this.stopHeartbeat();
    this.ws?.close();
    this.ws = null;
    this.flushPending(new Error("gateway client stopped"));
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  request<Method extends GatewayMethod>(
    method: Method,
    params: GatewayMethodParams[Method],
  ): Promise<GatewayMethodResult[Method]>;
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("gateway not connected"));
    }
    const id = generateRequestId();
    const frame = { type: "req", id, method, params };
    this.opts.onSendFrame?.(`req:${method}`);
    const p = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject });
    });
    this.ws.send(JSON.stringify(frame));
    return p;
  }

  private connect() {
    if (this.closed) return;
    this.ws = new WebSocket(this.opts.url, this.opts.protocols);
    this.ws.addEventListener("open", () => {
      this.opts.onOpen?.();
      this.queueConnect();
    });
    this.ws.addEventListener("message", (ev) =>
      this.handleMessage(String(ev.data ?? "")),
    );
    this.ws.addEventListener("close", (ev) => {
      const reason = String(ev.reason ?? "");
      this.ws = null;
      this.stopHeartbeat();
      this.flushPending(new Error(`gateway closed (${ev.code}): ${reason}`));
      this.opts.onClose?.({ code: ev.code, reason });
    });
    this.ws.addEventListener("error", () => {
      // Error is followed by close event which handles reconnect.
    });
  }

  private flushPending(err: Error) {
    for (const [, p] of this.pending) {
      p.reject(err);
    }
    this.pending.clear();
  }

  private async sendConnect() {
    if (this.connectSent) return;
    this.connectSent = true;
    if (this.connectTimer !== null) {
      window.clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }

    const scopes = ["operator.admin", "operator.approvals", "operator.pairing"];
    const role = "operator";

    let deviceIdentity: DeviceIdentity | null = null;
    let authToken = this.opts.token ?? loadDeviceAuthToken();

    // crypto.subtle is only available in secure contexts (HTTPS, localhost).
    const isSecureContext = typeof crypto !== "undefined" && !!crypto.subtle;

    let device: ConnectParams["device"];

    if (isSecureContext) {
      try {
        deviceIdentity = await loadOrCreateDeviceIdentity();
        const signedAtMs = Date.now();
        const nonce = this.connectNonce ?? undefined;
        const payload = buildDeviceAuthPayload({
          deviceId: deviceIdentity.deviceId,
          clientId: CLIENT_ID,
          clientMode: CLIENT_MODE,
          role,
          scopes,
          signedAtMs,
          token: authToken ?? null,
          nonce,
        });
        const signature = await signDevicePayload(
          deviceIdentity.privateKey,
          payload,
        );
        device = {
          id: deviceIdentity.deviceId,
          publicKey: deviceIdentity.publicKey,
          signature,
          signedAt: signedAtMs,
          nonce,
        };
      } catch (err) {
        console.warn(
          "[gateway] device identity failed, falling back to token-only:",
          err,
        );
      }
    }

    const password = import.meta.env.VITE_GATEWAY_PASSWORD?.trim() || undefined;
    const auth =
      authToken || password
        ? {
            ...(authToken ? { token: authToken } : {}),
            ...(password ? { password } : {}),
          }
        : undefined;

    const params: ConnectParams = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: CLIENT_ID,
        version: "app-0.1",
        platform: navigator.platform ?? "web",
        mode: CLIENT_MODE,
      },
      role,
      scopes,
      device,
      caps: [],
      auth,
      userAgent: navigator.userAgent,
      locale: navigator.language,
    };

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.ws?.close(4008, "connect failed");
      return;
    }

    this.ws.send(
      JSON.stringify({
        type: "req",
        id: generateRequestId(),
        method: "connect",
        params,
      }),
    );
    this.opts.onSendFrame?.("req:connect");
  }

  private handleMessage(raw: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    this.opts.onReceiveFrame?.(gatewayFrameType(parsed) ?? "unknown");

    const eventFrame = parseGatewayEventFrame(parsed);
    if (eventFrame) {
      const evt = eventFrame;
      if (evt.event === "connect.challenge") {
        const nonce = evt.payload.nonce;
        if (nonce) {
          this.connectNonce = nonce;
          void this.sendConnect();
        }
        return;
      }
      try {
        this.opts.onEvent?.(evt);
      } catch (err) {
        console.error("[gateway] event handler error:", err);
      }
      return;
    }

    const helloFrame = parseGatewayHelloOk(parsed);
    if (helloFrame) {
      const hello = helloFrame;
      this.connectSent = true;
      this.startHeartbeat();
      if (hello?.auth?.deviceToken) {
        storeDeviceAuthToken(hello.auth.deviceToken);
      }
      this.opts.onHello?.(hello);
      return;
    }

    const responseFrame = parseGatewayResponseFrame(parsed);
    if (responseFrame) {
      const res = responseFrame;
      const pending = this.pending.get(res.id);
      if (!pending) return;
      this.pending.delete(res.id);
      if (res.ok) {
        pending.resolve(res.payload);
      } else {
        pending.reject(new GatewayRequestError(res.error));
      }
    }
  }

  private queueConnect() {
    this.connectSent = false;
    if (this.connectTimer !== null) {
      window.clearTimeout(this.connectTimer);
    }
    this.connectTimer = window.setTimeout(() => {
      void this.sendConnect();
    }, 0);
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.ws.send(JSON.stringify({ type: "ping", ts: Date.now() }));
      this.opts.onSendFrame?.("ping");
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
