import { create } from "zustand";
import {
  clearAllSupabaseAuthStorage,
  clearOtherSupabaseAuthStorage,
  getSupabaseClient,
} from "../api/supabase";
import { brokerLogout, establishBrokerSession } from "../api/broker-session";
import { fetchSetupAuthState } from "../api/setup";
import { queryClient } from "../api/query-client";
import { queryKeys } from "../api/query-keys";
import { useAgentsStore } from "./agents";
import { useOnboardingStore } from "./onboarding";
import { describeSignInError } from "../lib/auth-error";
import type { OnboardingReason } from "../api/ws-types";
import type {
  DefaultAgentsAuthState,
  DefaultAgentsOnboardingState,
  ManagerAgentAuthState,
  SetupAuthState,
} from "../../../../contracts/setup";

export type { OnboardingReason } from "../api/ws-types";

export type AuthStatus =
  | "loading"
  | "unauthenticated"
  | "preparing"
  | "authenticated";

type AuthState = {
  status: AuthStatus;
  error: string | null;
  userId: string | null;
  resolvedAgentId: string | null;
  workspaceId: string | null;
  onboardingReason: OnboardingReason | null;
  defaultAgents: DefaultAgentsAuthState;
  managerAgent: ManagerAgentAuthState;
  defaultAgentOnboarding: DefaultAgentsOnboardingState;
  providerWarnings: string[];
  existingAgents: SetupAuthState["agents"];
  workspaces: SetupAuthState["workspaces"];

  // Actions
  init: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  orchestrate: () => Promise<void>;
  /** Re-run orchestrate after onboarding completes */
  completeOnboarding: () => Promise<void>;
  applyAuthState: (auth: SetupAuthState) => void;
  setError: (error: string | null) => void;
  setResolvedContext: (context: {
    agentId: string;
    workspaceId: string;
  }) => void;
};

const EMPTY_DEFAULT_AGENTS: DefaultAgentsAuthState = {
  planning: { agentId: null, configured: false, missing: [] },
  coding: { agentId: null, configured: false, missing: [] },
};

const EMPTY_MANAGER_AGENT: ManagerAgentAuthState = {
  agentId: null,
  configured: false,
  missing: [],
};

const EMPTY_DEFAULT_AGENT_ONBOARDING: DefaultAgentsOnboardingState = {
  required: false,
  blocking: false,
  reasons: [],
};

function resolveInitialAgentId(auth: SetupAuthState): string | null {
  if (auth.resolvedAgentId) {
    return auth.resolvedAgentId;
  }
  if (
    auth.defaultAgents.planning.configured &&
    auth.defaultAgents.planning.agentId
  ) {
    return auth.defaultAgents.planning.agentId;
  }
  if (
    auth.defaultAgents.coding.configured &&
    auth.defaultAgents.coding.agentId
  ) {
    return auth.defaultAgents.coding.agentId;
  }
  return (
    auth.defaultAgents.planning.agentId ??
    auth.defaultAgents.coding.agentId ??
    null
  );
}

export const useAuthStore = create<AuthState>((set, get) => {
  function applyAuthState(auth: SetupAuthState) {
    set({
      userId: auth.userId,
      resolvedAgentId: resolveInitialAgentId(auth),
      workspaceId: auth.workspaceId || null,
      defaultAgents: auth.defaultAgents,
      managerAgent: auth.managerAgent,
      defaultAgentOnboarding: auth.onboarding,
      existingAgents: auth.agents || [],
      workspaces: auth.workspaces || [],
    });
  }

  async function orchestrate() {
    set({ status: "preparing", error: null, providerWarnings: [] });
    try {
      const auth = await queryClient.fetchQuery({
        queryKey: queryKeys.auth.state(),
        queryFn: fetchSetupAuthState,
      });
      const agentId = resolveInitialAgentId(auth);

      applyAuthState(auth);

      if (!auth.workspaceId) {
        throw new Error(
          "Workspace bootstrap failed: /api/auth/state returned no workspaceId",
        );
      }

      // Users can enter the dashboard once auth bootstrap has produced a
      // workspace. If agents need setup, the OnboardingModal surfaces guidance
      // non-blockingly.
      set({
        status: "authenticated",
        resolvedAgentId: agentId ?? null,
        onboardingReason: auth.onboarding.required ? "setup_required" : null,
        providerWarnings: [],
        error: null,
      });
    } catch (err) {
      const message = (err as Error).message ?? "Unknown error";
      // Distinguish auth failures from backend/network errors so devs
      // can tell whether the problem is credentials or infrastructure.
      const isAuthError =
        message.includes("auth") ||
        message.includes("token") ||
        message.includes("401");
      const errorKind = isAuthError ? "auth" : "backend";
      console.error(`[auth-store] orchestrate failed (${errorKind}):`, message);
      if (import.meta.env.DEV) {
        console.warn(
          `[auth-store] Debug: If this is a Supabase outage, check https://status.supabase.com/\n` +
            `  Error kind: ${errorKind}\n` +
            `  Full error: ${message}`,
        );
      }
      set({
        error: message,
        status: "unauthenticated",
        userId: null,
        providerWarnings: [],
      });
    }
  }

  return {
    status: "loading",
    error: null,
    userId: null,
    resolvedAgentId: null,
    workspaceId: null,
    onboardingReason: null,
    defaultAgents: EMPTY_DEFAULT_AGENTS,
    managerAgent: EMPTY_MANAGER_AGENT,
    defaultAgentOnboarding: EMPTY_DEFAULT_AGENT_ONBOARDING,
    providerWarnings: [],
    existingAgents: [],
    workspaces: [],

    init: async () => {
      try {
        clearOtherSupabaseAuthStorage();
        const supabase = getSupabaseClient();

        // Listen for token refresh / sign out
        supabase.auth.onAuthStateChange(async (event, session) => {
          if (
            (event === "TOKEN_REFRESHED" || event === "SIGNED_IN") &&
            session?.access_token
          ) {
            try {
              await establishBrokerSession(session.access_token);
            } catch (err) {
              console.warn(
                "[auth-store] broker session refresh failed:",
                (err as Error).message,
              );
            }
          }
          if (event === "SIGNED_OUT") {
            queryClient.clear();
            useAgentsStore.getState().reset();
            useOnboardingStore.getState().reset();
            set({
              status: "unauthenticated",
              userId: null,
              resolvedAgentId: null,
              workspaceId: null,
              onboardingReason: null,
              defaultAgents: EMPTY_DEFAULT_AGENTS,
              managerAgent: EMPTY_MANAGER_AGENT,
              defaultAgentOnboarding: EMPTY_DEFAULT_AGENT_ONBOARDING,
              // A delayed SIGNED_OUT event from login-page cleanup can arrive
              // after a failed sign-in. Preserve that failure for the form.
              error: get().error,
            });
          }
        });

        // Check existing session
        const { data } = await supabase.auth.getSession();
        if (!data.session?.access_token) {
          queryClient.clear();
          useAgentsStore.getState().reset();
          set({ status: "unauthenticated", userId: null });
          return;
        }
        await establishBrokerSession(data.session.access_token);
        await orchestrate();
      } catch (err) {
        const message = (err as Error).message ?? "Unknown error";
        console.error("[auth-store] init failed:", message);
        queryClient.clear();
        useAgentsStore.getState().reset();
        set({ error: message, status: "unauthenticated", userId: null });
      }
    },

    signIn: async (email, password) => {
      queryClient.clear();
      useAgentsStore.getState().reset();
      useOnboardingStore.getState().reset();
      set({ error: null, status: "loading", userId: null });
      try {
        clearAllSupabaseAuthStorage();
        const supabase = getSupabaseClient();
        const { data, error: authError } =
          await supabase.auth.signInWithPassword({ email, password });
        if (authError || !data.session?.access_token) {
          throw authError || new Error("No session token");
        }
        await establishBrokerSession(data.session.access_token);
        await orchestrate();
      } catch (err) {
        const message = (err as Error).message ?? "Unknown error";
        console.error("[auth-store] signIn failed:", message);
        queryClient.clear();
        useAgentsStore.getState().reset();
        set({
          error: describeSignInError(err),
          status: "unauthenticated",
          userId: null,
        });
      }
    },

    signUp: async (email, password) => {
      queryClient.clear();
      useAgentsStore.getState().reset();
      useOnboardingStore.getState().reset();
      set({ error: null, status: "loading", userId: null });
      try {
        clearAllSupabaseAuthStorage();
        const supabase = getSupabaseClient();
        const { data, error: authError } = await supabase.auth.signUp({
          email,
          password,
        });
        if (authError) throw authError;

        // If Supabase returns a session (email confirmation disabled), sign in immediately
        if (data.session?.access_token) {
          await establishBrokerSession(data.session.access_token);
          await orchestrate();
          return;
        }

        // Email confirmation required — show a message and stay unauthenticated
        set({
          status: "unauthenticated",
          userId: null,
          error: "Sign-up complete. Check your email for verification.",
        });
      } catch (err) {
        const message = (err as Error).message ?? "Unknown error";
        console.error("[auth-store] signUp failed:", message);
        queryClient.clear();
        useAgentsStore.getState().reset();
        set({ error: message, status: "unauthenticated", userId: null });
      }
    },

    signOut: async () => {
      queryClient.clear();
      useAgentsStore.getState().reset();
      useOnboardingStore.getState().reset();
      const supabase = getSupabaseClient();
      await supabase.auth.signOut();
      await brokerLogout();
      clearAllSupabaseAuthStorage();
      set({
        status: "unauthenticated",
        resolvedAgentId: null,
        userId: null,
        workspaceId: null,
        onboardingReason: null,
        defaultAgents: EMPTY_DEFAULT_AGENTS,
        managerAgent: EMPTY_MANAGER_AGENT,
        defaultAgentOnboarding: EMPTY_DEFAULT_AGENT_ONBOARDING,
        error: null,
      });
    },

    orchestrate,

    completeOnboarding: async () => {
      await orchestrate();
    },

    applyAuthState,
    setError: (error) => set({ error }),
    setResolvedContext: ({ agentId, workspaceId }) =>
      set({
        resolvedAgentId: agentId,
        workspaceId,
        status: "authenticated",
        onboardingReason: null,
        defaultAgentOnboarding: EMPTY_DEFAULT_AGENT_ONBOARDING,
        error: null,
      }),
  };
});
