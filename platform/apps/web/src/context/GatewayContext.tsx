import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  type ReactNode,
} from "react";
import type {
  AuthStateAgent,
  GatewayRequest,
  RuntimeScope,
} from "../api/ws-types";
import {
  initializeWebSocket,
  prepareGatewayRuntime,
  resolveScope,
} from "./GatewayContext/connect";
import {
  initialGatewayDiagnostics,
  type GatewayContextValue,
  type GatewayStatus,
} from "./GatewayContext/types";
import { useGatewayReadinessPoll } from "./GatewayContext/useGatewayReadinessPoll";
import { useGatewayQueryInvalidation } from "../api/gateway-query-invalidation";
import { useGatewayReconnection } from "./GatewayContext/useGatewayReconnection";
import { useGatewayState } from "./GatewayContext/useGatewayState";

export type { GatewayStatus } from "./GatewayContext/types";

const GatewayContext = createContext<GatewayContextValue>({
  client: null,
  connected: false,
  status: "resolving_scope",
  hello: null,
  diagnostics: initialGatewayDiagnostics,
  gatewayReady: null,
  scope: null,
  target: null,
  prepareError: null,
  clearPrepareError: () => {},
  connect: () => Promise.reject(new Error("no gateway")),
  disconnect: () => {},
  request: ((method: string, _params?: unknown) =>
    Promise.reject(new Error(`no gateway for ${method}`))) as GatewayRequest,
  addEventListener: () => () => {},
});

export function useGatewayContext() {
  return useContext(GatewayContext);
}

export function GatewayProvider({
  children,
  autoConnect = true,
  scopeOverride = null,
  targetOverride = null,
}: {
  children: ReactNode;
  autoConnect?: boolean;
  scopeOverride?: RuntimeScope | null;
  targetOverride?: AuthStateAgent | null;
}) {
  const state = useGatewayState({ autoConnect, targetOverride });
  const { clearReconnectTimer, scheduleReconnect, disconnect } =
    useGatewayReconnection({
      state,
      targetOverride,
    });

  const connect = useCallback(async () => {
    state.allowReconnectRef.current = autoConnect;
    if (state.clientRef.current?.connected) return;
    if (state.connectPromiseRef.current) return state.connectPromiseRef.current;

    const promise = (async () => {
      const generation = state.connectionGenerationRef.current + 1;
      state.connectionGenerationRef.current = generation;
      const ensureCurrentConnection = () => {
        if (
          state.connectionGenerationRef.current !== generation ||
          !state.allowReconnectRef.current
        ) {
          throw new Error("gateway connection superseded");
        }
      };

      state.setDiagnostics((current) => ({
        ...current,
        connectAttempts: current.connectAttempts + 1,
      }));
      state.setStatus("resolving_scope");

      const { resolvedScope, resolvedTarget } = await resolveScope({
        scopeOverride,
        targetOverride,
        setStatus: state.setStatus,
      });

      console.debug("[gateway-context] resolved runtime scope", resolvedScope);
      ensureCurrentConnection();
      state.setScope(resolvedScope);
      state.setTarget(resolvedTarget);

      const readyToConnect = await prepareGatewayRuntime({
        resolvedScope,
        setPrepareError: state.setPrepareError,
        setStatus: state.setStatus,
        scheduleReconnect,
        ensureCurrentConnection,
      });
      if (!readyToConnect) return;

      state.setStatus("connecting");
      await initializeWebSocket({
        resolvedScope,
        generation,
        connectionGenerationRef: state.connectionGenerationRef,
        clientRef: state.clientRef,
        listenersRef: state.listenersRef,
        setConnected: state.setConnected,
        setDiagnostics: state.setDiagnostics,
        setHello: state.setHello,
        setStatus: state.setStatus,
        scheduleReconnect,
        ensureCurrentConnection,
      });
    })().finally(() => {
      state.connectPromiseRef.current = null;
    });

    state.connectPromiseRef.current = promise;
    return promise;
  }, [
    autoConnect,
    scheduleReconnect,
    scopeOverride,
    state.allowReconnectRef,
    state.clientRef,
    state.connectPromiseRef,
    state.connectionGenerationRef,
    state.listenersRef,
    state.setConnected,
    state.setDiagnostics,
    state.setHello,
    state.setPrepareError,
    state.setScope,
    state.setStatus,
    state.setTarget,
    targetOverride,
  ]);

  useEffect(() => {
    state.allowReconnectRef.current = autoConnect;
    if (autoConnect) {
      void connect().catch(() => {});
    }
  }, [autoConnect, connect, state.allowReconnectRef, state.reconnectNonce]);

  useEffect(() => {
    return () => {
      disconnect();
      state.setScope(null);
    };
  }, [disconnect, state.setScope]);

  useGatewayReadinessPoll({
    clearReconnectTimer,
    setGatewayReady: state.setGatewayReady,
  });

  const request = useCallback(
    ((method: string, params?: unknown) => {
      const client = state.clientRef.current;
      if (!client) return Promise.reject(new Error("no gateway client"));
      return client.request(method, params);
    }) as GatewayRequest,
    [state.clientRef],
  );

  const addEventListener = useCallback(
    (handler: Parameters<GatewayContextValue["addEventListener"]>[0]) => {
      state.listenersRef.current.add(handler);
      return () => {
        state.listenersRef.current.delete(handler);
      };
    },
    [state.listenersRef],
  );

  useGatewayQueryInvalidation({
    addEventListener,
    scope: state.scope,
  });

  useEffect(() => {
    const debugTarget = window as typeof window & {
      __openclawGatewayDebug?: {
        getState: () => {
          connected: boolean;
          status: GatewayStatus;
          gatewayReady: boolean | null;
          scope: RuntimeScope | null;
          target: AuthStateAgent | null;
          hello: GatewayContextValue["hello"];
          diagnostics: GatewayContextValue["diagnostics"];
        };
        connect: () => Promise<void>;
        disconnect: () => void;
        request: GatewayRequest;
      };
    };

    debugTarget.__openclawGatewayDebug = {
      getState: () => ({
        connected: state.connected,
        status: state.status,
        gatewayReady: state.gatewayReady,
        scope: state.scope,
        target: state.target,
        hello: state.hello,
        diagnostics: state.diagnostics,
      }),
      connect,
      disconnect,
      request,
    };

    return () => {
      delete debugTarget.__openclawGatewayDebug;
    };
  }, [
    connect,
    disconnect,
    request,
    state.connected,
    state.diagnostics,
    state.gatewayReady,
    state.hello,
    state.scope,
    state.status,
    state.target,
  ]);

  return (
    <GatewayContext.Provider
      value={{
        client: state.clientRef.current,
        connected: state.connected,
        status: state.status,
        hello: state.hello,
        diagnostics: state.diagnostics,
        gatewayReady: state.gatewayReady,
        scope: state.scope,
        target: state.target,
        prepareError: state.prepareError,
        clearPrepareError: () => state.setPrepareError(null),
        connect,
        disconnect,
        request,
        addEventListener,
      }}
    >
      {children}
    </GatewayContext.Provider>
  );
}
