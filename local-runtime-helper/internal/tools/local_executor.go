package tools

import (
	"context"
	"os"
	"time"

	"github.com/kmgrassi/local-runtime-helper/internal/runner"
)

const (
	defaultTimeout     = 120 * time.Second
	defaultOutputLimit = 64 * 1024
	defaultFileLimit   = 64 * 1024
	maxFileLimit       = 256 * 1024
	defaultListLimit   = 50
	maxListLimit       = 200
	defaultListDepth   = 2
	maxListDepth       = 8
	defaultSnippet     = 240
	maxSnippet         = 1000
)

type Executor struct {
	workspaceRoot string
	toolPath      string
}

func NewExecutor(workspaceRoot string) (*Executor, error) {
	root, err := canonicalDirectory(workspaceRoot)
	if err != nil {
		return nil, err
	}
	return &Executor{workspaceRoot: root, toolPath: normalizedToolPath(os.Getenv("PATH"))}, nil
}

func (e *Executor) Execute(ctx context.Context, req runner.ToolCallRequest) runner.ToolCallResult {
	started := time.Now()
	output, ok := e.execute(ctx, req)
	output["tool"] = req.Name
	output["tool_call_id"] = req.ToolCallID
	return runner.ToolCallResult{
		ToolCallID: req.ToolCallID,
		Success:    ok,
		Output:     output,
		DurationMs: time.Since(started).Milliseconds(),
	}
}

func (e *Executor) execute(ctx context.Context, req runner.ToolCallRequest) (map[string]any, bool) {
	switch req.Name {
	case "git.run":
		return e.gitRun(ctx, req.Arguments)
	case "shell.exec":
		return e.shellExec(ctx, req.Arguments)
	case "repo.list":
		return e.repoList(req.Arguments, req.Context)
	case "repo.read_file":
		return e.repoReadFile(req.Arguments, req.Context)
	case "repo.search":
		return e.repoSearch(ctx, req.Arguments, req.Context)
	default:
		return map[string]any{
			"ok":    false,
			"error": "unsupported_local_tool",
			"name":  req.Name,
		}, false
	}
}

func (e *Executor) gitRun(ctx context.Context, args map[string]any) (map[string]any, bool) {
	argv, err := commandArgv(args)
	if err != nil {
		return errorOutput(err), false
	}
	if err := allowedGitCommand(argv); err != nil {
		return map[string]any{
			"ok":      false,
			"blocked": true,
			"error":   "command_blocked",
			"reason":  err.Error(),
			"argv":    argv,
		}, false
	}
	return e.runCommand(ctx, argv, args)
}

// shellExec runs an arbitrary command in the workspace for a local model. Unlike
// gitRun it applies no command allowlist (shell.exec is a general CLI tool), but
// it shares the same workspace-root cwd confinement, timeout, and output caps.
// The orchestrator's sandbox_policy is not enforced here: the helper runs as the
// user on the user's own machine, which is the point of a local-model agent.
func (e *Executor) shellExec(ctx context.Context, args map[string]any) (map[string]any, bool) {
	argv, err := commandArgv(args)
	if err != nil {
		return errorOutput(err), false
	}
	return e.runCommand(ctx, argv, args)
}
