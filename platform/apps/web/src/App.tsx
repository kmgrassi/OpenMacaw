import { Suspense, lazy, useEffect, useLayoutEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { LoadingState } from "./components/ui/LoadingState";
import { installBrowserConsoleErrorCapture } from "./lib/browser-console-errors";
import { useAuthStore } from "./stores/auth";

const Login = lazy(async () => {
  const module = await import("./components/Login");
  return { default: module.Login };
});

const SignUp = lazy(async () => {
  const module = await import("./components/SignUp");
  return { default: module.SignUp };
});

const Home = lazy(async () => {
  const module = await import("./routes/Home");
  return { default: module.Home };
});

const Landing = lazy(async () => {
  const module = await import("./routes/Landing");
  return { default: module.Landing };
});

const Onboarding = lazy(async () => {
  const module = await import("./routes/Onboarding");
  return { default: module.Onboarding };
});

const Dashboard = lazy(async () => {
  const module = await import("./routes/Dashboard");
  return { default: module.Dashboard };
});

const SettingsLayout = lazy(async () => {
  const module = await import("./routes/Settings");
  return { default: module.SettingsLayout };
});

const NewPlan = lazy(async () => {
  const module = await import("./pages/plans/NewPlan");
  return { default: module.NewPlan };
});

const WorkspaceItems = lazy(async () => {
  const module = await import("./routes/WorkspaceItems");
  return { default: module.WorkspaceItems };
});

const PlanDetail = lazy(async () => {
  const module = await import("./pages/plans/PlanDetail");
  return { default: module.PlanDetail };
});

const SettingsIndex = lazy(async () => {
  const module = await import("./routes/Settings");
  return { default: module.SettingsIndex };
});

const AgentsSection = lazy(async () => {
  const module = await import("./components/settings/AgentsSection");
  return { default: module.AgentsSection };
});

const ManagerAgentSection = lazy(async () => {
  const module = await import("./components/settings/ManagerAgentSection");
  return { default: module.ManagerAgentSection };
});

const ChannelsSection = lazy(async () => {
  const module = await import("./components/settings/ChannelsSection");
  return { default: module.ChannelsSection };
});

const ModelsSection = lazy(async () => {
  const module = await import("./components/settings/ModelsSection");
  return { default: module.ModelsSection };
});

const SessionsSection = lazy(async () => {
  const module = await import("./components/settings/SessionsSection");
  return { default: module.SessionsSection };
});

const UsageSection = lazy(async () => {
  const module = await import("./components/settings/UsageSection");
  return { default: module.UsageSection };
});

const MemorySection = lazy(async () => {
  const module = await import("./components/settings/MemorySection");
  return { default: module.MemorySection };
});

const SkillsSection = lazy(async () => {
  const module = await import("./components/settings/SkillsSection");
  return { default: module.SkillsSection };
});

const ConfigSection = lazy(async () => {
  const module = await import("./components/settings/ConfigSection");
  return { default: module.ConfigSection };
});

const RuntimeSection = lazy(async () => {
  const module = await import("./components/settings/RuntimeSection");
  return { default: module.RuntimeSection };
});

const DebugSection = lazy(async () => {
  const module = await import("./components/settings/DebugSection");
  return { default: module.DebugSection };
});

const LocalRuntimesSection = lazy(async () => {
  const module = await import("./components/settings/LocalRuntimesSection");
  return { default: module.LocalRuntimesSection };
});

const WorkspaceSection = lazy(async () => {
  const module = await import("./components/settings/WorkspaceSection");
  return { default: module.WorkspaceSection };
});

function RouteLoading() {
  return <LoadingState label="Loading..." variant="route" />;
}

function appBaseUrl() {
  return (
    import.meta.env.VITE_OPENMACAW_APP_BASE_URL?.trim() ||
    "https://app.openmacaw.ai"
  ).replace(/\/$/, "");
}

function isMarketingHost() {
  if (typeof window === "undefined") return false;
  return ["openmacaw.ai", "www.openmacaw.ai"].includes(
    window.location.hostname,
  );
}

function isProductionAppHost() {
  if (typeof window === "undefined") return false;
  return window.location.hostname === "app.openmacaw.ai";
}

function isLegacyAppHost() {
  if (typeof window === "undefined") return false;
  return window.location.hostname === "claw.harper.new";
}

function AppHostRedirect() {
  useEffect(() => {
    const target = `${appBaseUrl()}${window.location.pathname}${window.location.search}${window.location.hash}`;
    window.location.replace(target);
  }, []);

  return <LoadingState label="Opening app..." variant="route" />;
}

function AppOnlyRoute({ children }: { children: React.ReactNode }) {
  if (isMarketingHost() || isLegacyAppHost()) {
    return <AppHostRedirect />;
  }

  return <>{children}</>;
}

function RootRoute() {
  if (isLegacyAppHost()) {
    return <AppHostRedirect />;
  }

  if (isProductionAppHost()) {
    return (
      <AuthGate>
        <Home />
      </AuthGate>
    );
  }

  return <Landing appUrl={appBaseUrl()} />;
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const { status } = useAuthStore();

  if (status === "loading" || status === "preparing") {
    return (
      <LoadingState
        label={
          status === "loading" ? "Checking session..." : "Preparing runtime..."
        }
        variant="route"
      />
    );
  }

  if (status === "unauthenticated") {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

/** Redirects authenticated users away from auth pages */
function UnauthenticatedOnly({ children }: { children: React.ReactNode }) {
  const { status } = useAuthStore();

  if (status === "loading" || status === "preparing") {
    return <LoadingState label="Checking session..." variant="route" />;
  }

  if (status === "authenticated") {
    return <Navigate to="/app" replace />;
  }

  return <>{children}</>;
}

function LoginRoute() {
  const { signIn, error, setError, status } = useAuthStore();
  const isLoading = status === "loading" || status === "preparing";
  useLayoutEffect(() => {
    setError(null);
  }, [setError]);
  return (
    <UnauthenticatedOnly>
      <Login onSignIn={signIn} error={error} loading={isLoading} />
    </UnauthenticatedOnly>
  );
}

function SignUpRoute() {
  const { signUp, error, setError, status } = useAuthStore();
  const isLoading = status === "loading" || status === "preparing";
  useLayoutEffect(() => {
    setError(null);
  }, [setError]);
  return (
    <UnauthenticatedOnly>
      <SignUp onSignUp={signUp} error={error} loading={isLoading} />
    </UnauthenticatedOnly>
  );
}

function AppRoutes() {
  return (
    <Suspense fallback={<RouteLoading />}>
      <Routes>
        <Route path="/" element={<RootRoute />} />
        <Route
          path="/login"
          element={
            <AppOnlyRoute>
              <LoginRoute />
            </AppOnlyRoute>
          }
        />
        <Route
          path="/signup"
          element={
            <AppOnlyRoute>
              <SignUpRoute />
            </AppOnlyRoute>
          }
        />
        <Route
          path="/onboarding"
          element={
            <AppOnlyRoute>
              <AuthGate>
                <Onboarding />
              </AuthGate>
            </AppOnlyRoute>
          }
        />
        <Route
          path="/settings"
          element={
            <AppOnlyRoute>
              <AuthGate>
                <SettingsLayout />
              </AuthGate>
            </AppOnlyRoute>
          }
        >
          <Route index element={<SettingsIndex />} />
          <Route path="agents" element={<AgentsSection />} />
          <Route path="agents/new" element={<AgentsSection />} />
          <Route path="agents/:agentId" element={<AgentsSection />} />
          <Route path="manager" element={<ManagerAgentSection />} />
          <Route path="channels" element={<ChannelsSection />} />
          <Route path="models" element={<ModelsSection />} />
          <Route path="sessions" element={<SessionsSection />} />
          <Route path="memory" element={<MemorySection />} />
          <Route path="skills" element={<SkillsSection />} />
          <Route path="usage" element={<UsageSection />} />
          <Route path="config" element={<ConfigSection />} />
          <Route path="runtime" element={<RuntimeSection />} />
          <Route path="debug" element={<DebugSection />} />
          <Route path="local-runtimes" element={<LocalRuntimesSection />} />
          <Route path="workspace" element={<WorkspaceSection />} />
        </Route>
        <Route
          path="/work"
          element={
            <AppOnlyRoute>
              <AuthGate>
                <WorkspaceItems />
              </AuthGate>
            </AppOnlyRoute>
          }
        />
        <Route
          path="/plans/new"
          element={
            <AppOnlyRoute>
              <AuthGate>
                <NewPlan />
              </AuthGate>
            </AppOnlyRoute>
          }
        />
        <Route
          path="/plans/:planId"
          element={
            <AppOnlyRoute>
              <AuthGate>
                <PlanDetail />
              </AuthGate>
            </AppOnlyRoute>
          }
        />
        <Route
          path="/app"
          element={
            <AppOnlyRoute>
              <AuthGate>
                <Home />
              </AuthGate>
            </AppOnlyRoute>
          }
        />
        <Route
          path="/dashboard/:agentId"
          element={
            <AppOnlyRoute>
              <AuthGate>
                <Dashboard />
              </AuthGate>
            </AppOnlyRoute>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}

export function App() {
  const init = useAuthStore((s) => s.init);

  useEffect(() => {
    return installBrowserConsoleErrorCapture();
  }, []);

  useEffect(() => {
    init();
  }, [init]);

  return (
    <BrowserRouter>
      <div className="h-full">
        <AppRoutes />
      </div>
    </BrowserRouter>
  );
}
