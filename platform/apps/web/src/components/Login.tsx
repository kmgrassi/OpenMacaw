import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import {
  clearAllSupabaseAuthStorage,
  getSupabaseConfigStatus,
  getSupabaseClient,
} from "../api/supabase";
import { Button } from "./ui/Button";
import { Card } from "./ui/Card";
import { Input } from "./ui/Input";

type Props = {
  onSignIn: (email: string, password: string) => Promise<void>;
  error: string | null;
  loading: boolean;
};

export function Login({ onSignIn, error, loading }: Props) {
  const supabaseConfig = getSupabaseConfigStatus();
  const authDisabled = !supabaseConfig.configured;
  // Wipe any existing Supabase session when this page mounts. Prevents a
  // stale session from a prior environment (e.g. dev/prod flip at the same
  // origin, or a cross-project token that leaked into localStorage) from
  // interfering with the fresh sign-in the user is about to perform.
  //
  // The signOut is async and emits a late `SIGNED_OUT` event. If the user
  // (or their password manager) submits credentials before signOut
  // completes, the sequence becomes:
  //   signInWithPassword resolves → session set
  //   signOut's SIGNED_OUT event fires → session wiped
  //   user appears "logged in then immediately logged out"
  // We avoid that race by blocking the form until signOut resolves.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!supabaseConfig.configured) {
        if (!cancelled) setReady(true);
        return;
      }
      try {
        await getSupabaseClient().auth.signOut({ scope: "local" });
        clearAllSupabaseAuthStorage();
      } catch {
        // no-op — nothing to sign out of, or network hiccup. We mark
        // the form ready anyway so a transient error doesn't lock the
        // user out of signing in. The SIGNED_OUT event, if it fires at
        // all in the failure case, precedes the user's submission.
        clearAllSupabaseAuthStorage();
      }
      if (!cancelled) setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [supabaseConfig.configured]);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // The auto-login button is local-dev-only (gated on `import.meta.env.DEV`)
  // so a production Netlify build cannot expose it even if these env vars
  // were ever baked in by accident. Within local dev, the cred pair we
  // surface follows `VITE_SUPABASE_ENV` so the button always logs into the
  // same project the rest of the app is talking to.
  const supabaseEnv = import.meta.env.VITE_SUPABASE_ENV?.trim().toLowerCase();
  const isProdShortcut = supabaseEnv === "prod";
  const shortcutEmail = import.meta.env.DEV
    ? (isProdShortcut
        ? import.meta.env.VITE_PROD_LOGIN_EMAIL
        : import.meta.env.VITE_DEV_LOGIN_EMAIL
      )?.trim() ?? ""
    : "";
  const shortcutPassword = import.meta.env.DEV
    ? (isProdShortcut
        ? import.meta.env.VITE_PROD_LOGIN_PASSWORD
        : import.meta.env.VITE_DEV_LOGIN_PASSWORD
      ) ?? ""
    : "";
  const canUseShortcutLogin = Boolean(shortcutEmail && shortcutPassword);
  const shortcutLabel = isProdShortcut
    ? "Use prod test credentials"
    : "Use dev credentials";

  const handleSubmit = () => {
    if (!ready) return;
    if (!email.trim() || !password) return;
    void onSignIn(email.trim(), password);
  };

  const handleShortcutLogin = () => {
    if (!ready) return;
    if (!canUseShortcutLogin) return;
    void onSignIn(shortcutEmail, shortcutPassword);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 px-4 py-8 text-slate-100">
      <Card className="w-full max-w-sm border-slate-800 bg-slate-900/80 p-6 shadow-xl">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.24em] text-blue-300">
            Harper Parallel Agent
          </p>
          <h1 className="mt-3 text-2xl font-semibold text-white">Sign in</h1>
          <p className="mt-1 text-sm text-slate-400">
            Continue to your agent dashboard.
          </p>
        </div>

        <div className="mt-6 space-y-4">
          <Input
            label="Email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            disabled={authDisabled || !ready || loading}
          />
          <Input
            label="Password"
            type="password"
            placeholder="Password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            disabled={authDisabled || !ready || loading}
          />

          {!supabaseConfig.configured && (
            <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
              {supabaseConfig.message}
            </p>
          )}

          {error && <p className="text-sm text-red-400">{error}</p>}

          <Button
            type="button"
            onClick={handleSubmit}
            disabled={
              authDisabled || !ready || loading || !email.trim() || !password
            }
            className="w-full"
          >
            {!ready ? "Preparing..." : loading ? "Signing in..." : "Sign In"}
          </Button>

          {canUseShortcutLogin && (
            <Button
              type="button"
              variant="secondary"
              onClick={handleShortcutLogin}
              disabled={authDisabled || !ready || loading}
              className="w-full"
            >
              {shortcutLabel}
            </Button>
          )}
        </div>

        <p className="mt-6 text-center text-sm text-slate-400">
          Don't have an account?{" "}
          <Link to="/signup" className="text-blue-400 hover:text-blue-300">
            Sign up
          </Link>
        </p>
      </Card>
    </div>
  );
}
