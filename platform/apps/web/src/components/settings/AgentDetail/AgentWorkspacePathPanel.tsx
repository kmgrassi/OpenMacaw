import { useCallback, useEffect, useState } from "react";

import {
  fetchAgentWorkspacePath,
  pickDirectory,
  saveAgentWorkspacePath,
  validateDirectory,
  type ValidateDirectoryResult,
} from "../../../api/local-directory";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { Input } from "../../ui/Input";

const WORKSPACE_PATH_API_UNAVAILABLE_MESSAGE =
  "Workspace directory editing from this panel is only available when running the web app with the local development API. Use Local runtimes setup to configure the helper workspace root.";

type Props = {
  agentId: string;
  /**
   * Only render the panel for agents whose runner is local_model_coding;
   * other runner kinds don't honor the workspace path.
   */
  visible: boolean;
};

type LoadState =
  | { kind: "loading" }
  | {
      kind: "ready";
      savedPath: string | null;
      savedValidation: ValidateDirectoryResult | null;
    }
  | { kind: "error"; message: string };

export function AgentWorkspacePathPanel({ agentId, visible }: Props) {
  const workspacePathApiAvailable = import.meta.env.DEV;
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [draft, setDraft] = useState<string>("");
  const [draftValidation, setDraftValidation] =
    useState<ValidateDirectoryResult | null>(null);
  const [busy, setBusy] = useState<"idle" | "pick" | "validate" | "save">(
    "idle",
  );
  const [feedback, setFeedback] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const result = await fetchAgentWorkspacePath(agentId);
      setState({
        kind: "ready",
        savedPath: result.path,
        savedValidation: result.validation,
      });
      setDraft(result.path ?? "");
      setDraftValidation(result.validation);
    } catch (err) {
      setState({ kind: "error", message: (err as Error).message });
    }
  }, [agentId]);

  useEffect(() => {
    if (!visible || !workspacePathApiAvailable) return;
    void refresh();
  }, [visible, workspacePathApiAvailable, refresh]);

  if (!visible) return null;

  if (!workspacePathApiAvailable) {
    return (
      <Card>
        <div className="flex flex-col gap-2">
          <div className="text-sm font-medium text-slate-100">
            Workspace directory
          </div>
          <div className="text-sm text-slate-400">
            {WORKSPACE_PATH_API_UNAVAILABLE_MESSAGE}
          </div>
        </div>
      </Card>
    );
  }

  const onPick = async () => {
    setFeedback(null);
    setBusy("pick");
    try {
      const result = await pickDirectory({
        defaultLocation: draft || undefined,
        prompt: "Choose the directory this agent should operate in",
      });
      if (!result.cancelled) {
        setDraft(result.path);
        setDraftValidation(result.validation);
      }
    } catch (err) {
      setFeedback(`Picker failed: ${(err as Error).message}`);
    } finally {
      setBusy("idle");
    }
  };

  const onValidate = async () => {
    if (!draft.trim()) {
      setDraftValidation({ ok: false, path: "", reason: "not_absolute" });
      return;
    }
    setBusy("validate");
    setFeedback(null);
    try {
      const result = await validateDirectory(draft.trim());
      setDraftValidation(result);
    } catch (err) {
      setFeedback(`Validation failed: ${(err as Error).message}`);
    } finally {
      setBusy("idle");
    }
  };

  const onSave = async () => {
    setBusy("save");
    setFeedback(null);
    try {
      const trimmed = draft.trim();
      if (trimmed !== "") {
        const validation = await validateDirectory(trimmed);
        setDraftValidation(validation);
        if (!validation.ok) {
          setFeedback(`Save failed: path ${validationReasonLabel(validation.reason)}.`);
          return;
        }
      }
      const result = await saveAgentWorkspacePath(
        agentId,
        trimmed === "" ? null : trimmed,
      );
      setFeedback(
        result.workspacePath
          ? `Saved. Agent will operate in ${result.workspacePath}.`
          : "Saved. Workspace cleared.",
      );
      await refresh();
    } catch (err) {
      setFeedback(`Save failed: ${(err as Error).message}`);
    } finally {
      setBusy("idle");
    }
  };

  const onClear = async () => {
    if (!confirm("Clear the agent's workspace directory?")) return;
    setDraft("");
    setDraftValidation(null);
    setBusy("save");
    setFeedback(null);
    try {
      await saveAgentWorkspacePath(agentId, null);
      setFeedback("Cleared. The agent has no workspace directory.");
      await refresh();
    } catch (err) {
      setFeedback(`Clear failed: ${(err as Error).message}`);
    } finally {
      setBusy("idle");
    }
  };

  if (state.kind === "loading") {
    return (
      <Card>
        <div className="text-sm text-slate-400">Loading workspace path…</div>
      </Card>
    );
  }

  if (state.kind === "error") {
    return (
      <Card>
        <div className="text-sm text-red-300">
          Could not load workspace path: {state.message}
        </div>
        <div className="mt-2">
          <Button onClick={() => void refresh()}>Retry</Button>
        </div>
      </Card>
    );
  }

  const { savedPath, savedValidation } = state;
  const dirty = (savedPath ?? "") !== draft.trim();
  const draftValid = draftValidation?.ok === true;
  const draftError =
    draftValidation && !draftValidation.ok
      ? validationReasonLabel(draftValidation.reason)
      : null;

  return (
    <Card>
      <div className="flex flex-col gap-3">
        <div>
          <div className="text-sm font-medium text-slate-100">
            Workspace directory
          </div>
          <div className="text-xs text-slate-400">
            The local model will read, write, and run shell commands inside this
            directory. No default — this agent only operates where you point it.
          </div>
        </div>

        {savedPath === null ? (
          <div className="rounded-md border border-amber-700/50 bg-amber-950/30 px-3 py-2 text-sm text-amber-100">
            No workspace directory is configured. Pick one below before asking
            the agent to read or edit files. Chat-only questions still work
            without one — the agent will tell you when a tool needs a directory.
          </div>
        ) : savedValidation && !savedValidation.ok ? (
          <div className="rounded-md border border-red-800/60 bg-red-950/25 px-3 py-2 text-sm text-red-200">
            Saved path <code className="font-mono">{savedPath}</code> is no
            longer usable ({validationReasonLabel(savedValidation.reason)}).
            Pick a new directory.
          </div>
        ) : (
          <div className="rounded-md border border-emerald-800/40 bg-emerald-950/20 px-3 py-2 text-sm text-emerald-200">
            Agent operates in <code className="font-mono">{savedPath}</code> ✓
          </div>
        )}

        <div className="flex gap-2">
          <Input
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setDraftValidation(null);
            }}
            placeholder="/Users/you/code/your-repo"
            className="flex-1 font-mono text-sm"
          />
          <Button onClick={() => void onPick()} disabled={busy !== "idle"}>
            {busy === "pick" ? "Picking…" : "Browse…"}
          </Button>
          <Button
            onClick={() => void onValidate()}
            disabled={busy !== "idle" || !draft.trim()}
          >
            {busy === "validate" ? "Checking…" : "Check"}
          </Button>
        </div>

        {draftError && (
          <div className="text-xs text-red-300">
            <code className="font-mono">{draftValidation?.path || draft}</code>{" "}
            — {draftError}
          </div>
        )}
        {draftValid && draftValidation && (
          <div className="text-xs text-emerald-300">
            <code className="font-mono">{draftValidation.path}</code> — ready to
            save
          </div>
        )}

        <div className="flex items-center justify-between gap-2">
          <Button
            onClick={() => void onSave()}
            disabled={busy !== "idle" || !dirty}
          >
            {busy === "save" ? "Saving…" : "Save"}
          </Button>
          {savedPath !== null && (
            <Button onClick={() => void onClear()} disabled={busy !== "idle"}>
              Clear
            </Button>
          )}
        </div>

        {feedback && <div className="text-xs text-slate-300">{feedback}</div>}
      </div>
    </Card>
  );
}

function validationReasonLabel(
  reason: ValidateDirectoryResult extends infer R
    ? R extends { ok: false; reason: infer X }
      ? X
      : never
    : never,
): string {
  switch (reason) {
    case "not_absolute":
      return "must be an absolute path (e.g. start with `/`)";
    case "not_found":
      return "does not exist";
    case "not_a_directory":
      return "is not a directory";
    case "not_readable":
      return "is not readable by this user";
    default:
      return String(reason);
  }
}
