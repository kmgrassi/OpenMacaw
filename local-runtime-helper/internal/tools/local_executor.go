package tools

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/kmgrassi/local-runtime-helper/internal/runner"
)

const (
	defaultTimeout     = 120 * time.Second
	defaultOutputLimit = 64 * 1024
)

type Executor struct {
	workspaceRoot string
}

func NewExecutor(workspaceRoot string) (*Executor, error) {
	root, err := canonicalDirectory(workspaceRoot)
	if err != nil {
		return nil, err
	}
	return &Executor{workspaceRoot: root}, nil
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

func (e *Executor) runCommand(ctx context.Context, argv []string, args map[string]any) (map[string]any, bool) {
	cwd, err := e.resolveCWD(stringArg(args, "cwd"))
	if err != nil {
		return errorOutput(err), false
	}
	timeout := boundedDuration(args, "timeout_ms", time.Second, 10*time.Minute, defaultTimeout)
	outputLimit := boundedInt(args, "output_limit_bytes", 1, 1024*1024, defaultOutputLimit)

	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.CommandContext(runCtx, argv[0], argv[1:]...)
	cmd.Dir = cwd
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &limitedWriter{buf: &stdout, limit: outputLimit}
	cmd.Stderr = &limitedWriter{buf: &stderr, limit: outputLimit}

	err = cmd.Run()
	exitCode := 0
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			exitCode = exitErr.ExitCode()
		} else if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
			return map[string]any{
				"ok":             false,
				"error":          "command_timeout",
				"argv":           argv,
				"cwd":            cwd,
				"workspace_root": e.workspaceRoot,
				"timeout_ms":     int(timeout / time.Millisecond),
				"stdout":         stdout.String(),
				"stderr":         stderr.String(),
			}, false
		} else {
			return map[string]any{
				"ok":             false,
				"error":          "command_failed_to_start",
				"message":        err.Error(),
				"argv":           argv,
				"cwd":            cwd,
				"workspace_root": e.workspaceRoot,
				"stdout":         stdout.String(),
				"stderr":         stderr.String(),
			}, false
		}
	}

	ok := exitCode == 0
	return map[string]any{
		"ok":             ok,
		"exit_code":      exitCode,
		"argv":           argv,
		"cwd":            cwd,
		"workspace_root": e.workspaceRoot,
		"stdout":         stdout.String(),
		"stderr":         stderr.String(),
	}, ok
}

func commandArgv(args map[string]any) ([]string, error) {
	if raw, ok := args["argv"]; ok {
		items, ok := raw.([]any)
		if !ok {
			return nil, fmt.Errorf("argv must be an array")
		}
		argv := make([]string, 0, len(items))
		for _, item := range items {
			value, ok := item.(string)
			if !ok || strings.TrimSpace(value) == "" {
				return nil, fmt.Errorf("argv items must be non-empty strings")
			}
			argv = append(argv, value)
		}
		if len(argv) == 0 {
			return nil, fmt.Errorf("argv must not be empty")
		}
		return argv, nil
	}
	command := strings.TrimSpace(stringArg(args, "command"))
	if command == "" {
		return nil, fmt.Errorf("missing command")
	}
	return splitCommand(command)
}

func splitCommand(command string) ([]string, error) {
	var argv []string
	var current strings.Builder
	var quote rune
	escaped := false
	for _, r := range command {
		switch {
		case escaped:
			current.WriteRune(r)
			escaped = false
		case r == '\\':
			escaped = true
		case quote != 0:
			if r == quote {
				quote = 0
			} else {
				current.WriteRune(r)
			}
		case r == '\'' || r == '"':
			quote = r
		case r == ' ' || r == '\t' || r == '\n':
			if current.Len() > 0 {
				argv = append(argv, current.String())
				current.Reset()
			}
		default:
			current.WriteRune(r)
		}
	}
	if escaped {
		current.WriteRune('\\')
	}
	if quote != 0 {
		return nil, fmt.Errorf("invalid command syntax: unterminated quote")
	}
	if current.Len() > 0 {
		argv = append(argv, current.String())
	}
	if len(argv) == 0 {
		return nil, fmt.Errorf("missing command")
	}
	return argv, nil
}

func allowedGitCommand(argv []string) error {
	if len(argv) == 0 {
		return fmt.Errorf("missing_command")
	}
	switch argv[0] {
	case "git":
		return nil
	case "gh":
		return allowedGHCommand(argv[1:])
	default:
		return fmt.Errorf("unsupported_executable")
	}
}

func allowedGHCommand(argv []string) error {
	if len(argv) == 0 {
		return nil
	}
	switch argv[0] {
	case "auth":
		if len(argv) > 1 && argv[1] == "status" {
			return nil
		}
		return fmt.Errorf("gh_subcommand_denied")
	case "repo":
		if len(argv) > 1 && argv[1] == "delete" {
			return fmt.Errorf("gh_subcommand_denied")
		}
	case "secret", "variable", "api":
		return fmt.Errorf("gh_subcommand_denied")
	}
	return nil
}

func (e *Executor) resolveCWD(cwd string) (string, error) {
	if strings.TrimSpace(cwd) == "" {
		cwd = "."
	}
	var candidate string
	if filepath.IsAbs(cwd) {
		candidate = cwd
	} else {
		candidate = filepath.Join(e.workspaceRoot, cwd)
	}
	resolved, err := canonicalDirectory(candidate)
	if err != nil {
		return "", err
	}
	if !pathInside(resolved, e.workspaceRoot) {
		return "", fmt.Errorf("cwd outside workspace root")
	}
	return resolved, nil
}

func canonicalDirectory(path string) (string, error) {
	if strings.TrimSpace(path) == "" {
		return "", fmt.Errorf("workspace root is required")
	}
	expanded := filepath.Clean(path)
	if strings.HasPrefix(expanded, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		expanded = filepath.Join(home, strings.TrimPrefix(expanded, "~/"))
	}
	if !filepath.IsAbs(expanded) {
		return "", fmt.Errorf("path must be absolute")
	}
	resolved, err := filepath.EvalSymlinks(expanded)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", fmt.Errorf("path is not a directory")
	}
	return resolved, nil
}

func pathInside(path, root string) bool {
	if path == root {
		return true
	}
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func stringArg(args map[string]any, key string) string {
	if value, ok := args[key].(string); ok {
		return value
	}
	return ""
}

func boundedDuration(args map[string]any, key string, min, max, fallback time.Duration) time.Duration {
	value := boundedInt(args, key, int(min/time.Millisecond), int(max/time.Millisecond), int(fallback/time.Millisecond))
	return time.Duration(value) * time.Millisecond
}

func boundedInt(args map[string]any, key string, min, max, fallback int) int {
	raw, ok := args[key]
	if !ok {
		return fallback
	}
	var value int
	switch v := raw.(type) {
	case int:
		value = v
	case float64:
		value = int(v)
	default:
		return fallback
	}
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

func errorOutput(err error) map[string]any {
	return map[string]any{
		"ok":      false,
		"error":   "invalid_arguments",
		"message": err.Error(),
	}
}

type limitedWriter struct {
	buf   *bytes.Buffer
	limit int
}

func (w *limitedWriter) Write(p []byte) (int, error) {
	remaining := w.limit - w.buf.Len()
	if remaining > 0 {
		if len(p) <= remaining {
			_, _ = w.buf.Write(p)
		} else {
			_, _ = w.buf.Write(p[:remaining])
		}
	}
	return len(p), nil
}
