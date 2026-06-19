import { useState } from "react";
import { Link } from "react-router-dom";

import { getSupabaseConfigStatus } from "../api/supabase";
import { Button } from "./ui/Button";
import { Card } from "./ui/Card";
import { Input } from "./ui/Input";

type Props = {
  onSignUp: (email: string, password: string) => Promise<void>;
  error: string | null;
  loading: boolean;
};

export function SignUp({ onSignUp, error, loading }: Props) {
  const supabaseConfig = getSupabaseConfigStatus();
  const authDisabled = !supabaseConfig.configured;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const handleSubmit = () => {
    setLocalError(null);
    if (!email.trim() || !password) return;
    if (password !== confirmPassword) {
      setLocalError("Passwords do not match");
      return;
    }
    if (password.length < 6) {
      setLocalError("Password must be at least 6 characters");
      return;
    }
    void onSignUp(email.trim(), password);
  };

  const displayError = localError || error;

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 px-4 py-8 text-slate-100">
      <Card className="w-full max-w-sm border-slate-800 bg-slate-900/80 p-6 shadow-xl">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.24em] text-blue-300">
            Harper Parallel Agent
          </p>
          <h1 className="mt-3 text-2xl font-semibold text-white">
            Create account
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Set up a workspace and start your planning agent.
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
            disabled={authDisabled || loading}
          />
          <Input
            label="Password"
            type="password"
            placeholder="Password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={authDisabled || loading}
          />
          <Input
            label="Confirm password"
            type="password"
            placeholder="Confirm password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            disabled={authDisabled || loading}
          />

          {!supabaseConfig.configured && (
            <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
              {supabaseConfig.message}
            </p>
          )}

          {displayError && (
            <p
              className={`text-sm ${
                displayError.includes("Check your email")
                  ? "text-green-400"
                  : "text-red-400"
              }`}
            >
              {displayError}
            </p>
          )}

          <Button
            type="button"
            onClick={handleSubmit}
            disabled={
              authDisabled ||
              loading ||
              !email.trim() ||
              !password ||
              !confirmPassword
            }
            className="w-full"
          >
            {loading ? "Creating account..." : "Create account"}
          </Button>
        </div>

        <p className="mt-6 text-center text-sm text-slate-400">
          Already have an account?{" "}
          <Link to="/login" className="text-blue-400 hover:text-blue-300">
            Sign in
          </Link>
        </p>
      </Card>
    </div>
  );
}
