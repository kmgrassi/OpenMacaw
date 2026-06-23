import { useEffect, useMemo, useState } from "react";
import { Button } from "../ui/Button";
import { Checkbox } from "../ui/Checkbox";
import { FieldMessage } from "../ui/FieldMessage";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { Textarea } from "../ui/Textarea";
import type {
  ToolDefinition,
  ToolDefinitionInput,
} from "../../hooks/useToolDefinitions";

type ToolTemplate = {
  key: string;
  label: string;
  input: ToolDefinitionInput;
};

const EMPTY_PARAMETERS = `{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}`;

const TOOL_TEMPLATES: ToolTemplate[] = [
  {
    key: "shell_exec",
    label: "shell_exec",
    input: {
      slug: "shell.exec",
      name: "Run shell command",
      description: "Run a command in the configured workspace.",
      functionName: "shell_exec",
      type: "shell",
      executionKind: "shell",
      runnerKind: "local_model_coding",
      enabled: true,
      parameters: {
        type: "object",
        properties: {
          argv: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            description: "Command and arguments to run.",
          },
          cwd: {
            type: "string",
            description: "Optional working directory, such as /workspace.",
          },
        },
        required: ["argv"],
        additionalProperties: false,
      },
    },
  },
  {
    key: "write_file",
    label: "write_file",
    input: {
      slug: "repo.write_file",
      name: "Write file",
      description: "Write content to a file in the current repository.",
      functionName: "write_file",
      type: "repository",
      executionKind: "filesystem",
      runnerKind: "codex",
      enabled: true,
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Repository-relative file path.",
          },
          content: { type: "string", description: "Full file contents." },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    key: "run_command",
    label: "run_command",
    input: {
      slug: "shell.run_command",
      name: "Run command",
      description: "Run a shell command in the workspace.",
      functionName: "run_command",
      type: "shell",
      executionKind: "shell",
      runnerKind: "codex",
      enabled: true,
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Command to execute." },
          workingDirectory: {
            type: "string",
            description: "Working directory for the command.",
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
  {
    key: "git_status",
    label: "git_status",
    input: {
      slug: "git.status",
      name: "Git status",
      description: "Show repository branch and working tree status.",
      functionName: "git_status",
      type: "repository",
      executionKind: "shell",
      runnerKind: "codex",
      enabled: true,
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
];

const EXECUTION_KIND_OPTIONS = [
  { value: "", label: "No execution kind" },
  { value: "api", label: "API" },
  { value: "database", label: "Database" },
  { value: "filesystem", label: "Filesystem" },
  { value: "graphql", label: "GraphQL" },
  { value: "shell", label: "Shell" },
];

const RUNNER_KIND_OPTIONS = [
  { value: "", label: "No runner kind" },
  { value: "codex", label: "Codex" },
  { value: "planner", label: "Planner" },
  { value: "manager", label: "Manager" },
  { value: "local_relay", label: "Local relay" },
];

type Props = {
  tool: ToolDefinition | null;
  saving: boolean;
  onCancel: () => void;
  onSubmit: (input: ToolDefinitionInput) => Promise<void>;
};

function stringifyParameters(parameters: Record<string, unknown>) {
  return JSON.stringify(parameters, null, 2);
}

function toSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function inputFromTool(tool: ToolDefinition): ToolDefinitionInput {
  return {
    slug: tool.slug,
    name: tool.name,
    description: tool.description,
    functionName: tool.functionName,
    parameters: tool.parameters,
    examples: tool.examples,
    type: tool.type,
    executionKind: tool.executionKind,
    runnerKind: tool.runnerKind,
    enabled: tool.enabled,
  };
}

export function ToolDefinitionEditor({
  tool,
  saving,
  onCancel,
  onSubmit,
}: Props) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [functionName, setFunctionName] = useState("");
  const [type, setType] = useState("");
  const [executionKind, setExecutionKind] = useState("");
  const [runnerKind, setRunnerKind] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [parametersText, setParametersText] = useState(EMPTY_PARAMETERS);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!tool) {
      setName("");
      setSlug("");
      setDescription("");
      setFunctionName("");
      setType("");
      setExecutionKind("");
      setRunnerKind("");
      setEnabled(true);
      setParametersText(EMPTY_PARAMETERS);
      setError(null);
      return;
    }

    const input = inputFromTool(tool);
    setName(input.name);
    setSlug(input.slug);
    setDescription(input.description);
    setFunctionName(input.functionName);
    setType(input.type ?? "");
    setExecutionKind(input.executionKind ?? "");
    setRunnerKind(input.runnerKind ?? "");
    setEnabled(input.enabled);
    setParametersText(stringifyParameters(input.parameters));
    setError(null);
  }, [tool]);

  const title = tool ? "Edit tool" : "Add tool";
  const formReady = name.trim() && slug.trim() && functionName.trim();

  const parametersError = useMemo(() => {
    try {
      const parsed: unknown = JSON.parse(parametersText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return "Parameters must be a JSON Schema object.";
      }
      return null;
    } catch {
      return "Parameters must be valid JSON.";
    }
  }, [parametersText]);

  const applyTemplate = (template: ToolTemplate) => {
    setName(template.input.name);
    setSlug(template.input.slug);
    setDescription(template.input.description);
    setFunctionName(template.input.functionName);
    setType(template.input.type ?? "");
    setExecutionKind(template.input.executionKind ?? "");
    setRunnerKind(template.input.runnerKind ?? "");
    setEnabled(template.input.enabled);
    setParametersText(stringifyParameters(template.input.parameters));
    setError(null);
  };

  const handleSubmit = async () => {
    setError(null);
    if (!formReady) {
      setError("Name, slug, and function name are required.");
      return;
    }

    let parameters: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(parametersText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setError("Parameters must be a JSON Schema object.");
        return;
      }
      parameters = parsed as Record<string, unknown>;
    } catch {
      setError("Parameters must be valid JSON.");
      return;
    }

    try {
      await onSubmit({
        slug: slug.trim(),
        name: name.trim(),
        description: description.trim(),
        functionName: functionName.trim(),
        parameters,
        type: type.trim() || null,
        executionKind: executionKind || null,
        runnerKind: runnerKind || null,
        enabled,
      });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="rounded-md border border-border bg-surface p-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h4 className="text-sm font-medium text-slate-200">{title}</h4>
        <div className="flex flex-wrap justify-end gap-2">
          {TOOL_TEMPLATES.map((template) => (
            <Button
              key={template.key}
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => applyTemplate(template)}
            >
              {template.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2">
          <Input
            label="Name"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              if (!tool && !slug.trim()) setSlug(toSlug(event.target.value));
            }}
            placeholder="Read file"
          />
          <Input
            label="Slug"
            value={slug}
            onChange={(event) => setSlug(toSlug(event.target.value))}
            placeholder="shell.exec"
          />
          <Input
            label="Function name"
            value={functionName}
            onChange={(event) =>
              setFunctionName(event.target.value.replace(/[^a-zA-Z0-9_]/g, "_"))
            }
            placeholder="read_file"
          />
          <Input
            label="Type"
            value={type}
            onChange={(event) => setType(event.target.value)}
            placeholder="repository"
          />
          <Select
            label="Execution kind"
            value={executionKind}
            onChange={(event) => setExecutionKind(event.target.value)}
            options={EXECUTION_KIND_OPTIONS}
          />
          <Select
            label="Runner kind"
            value={runnerKind}
            onChange={(event) => setRunnerKind(event.target.value)}
            options={RUNNER_KIND_OPTIONS}
          />
        </div>

        <Textarea
          id="tool-description"
          label="Description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          rows={3}
          placeholder="What this tool does and when the model should use it."
        />

        <Textarea
          id="tool-parameters"
          label="Parameters JSON Schema"
          value={parametersText}
          error={parametersError ?? undefined}
          onChange={(event) => setParametersText(event.target.value)}
          rows={10}
          spellCheck={false}
          className="font-mono text-xs"
        />

        <Checkbox
          label="Enabled"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />

        {error && <FieldMessage tone="error">{error}</FieldMessage>}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            loading={saving}
            disabled={!formReady || !!parametersError}
            onClick={handleSubmit}
          >
            Save tool
          </Button>
        </div>
      </div>
    </div>
  );
}
