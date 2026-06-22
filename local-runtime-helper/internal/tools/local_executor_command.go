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
)

func (e *Executor) runCommand(ctx context.Context, argv []string, args map[string]any) (map[string]any, bool) {
	cwd, err := e.resolveCWD(stringArg(args, "cwd"))
	if err != nil {
		return errorOutput(err), false
	}
	executable, err := e.lookupExecutable(argv[0], cwd)
	if err != nil {
		return map[string]any{
			"ok":      false,
			"error":   "tool_dependency_missing",
			"command": argv[0],
			"message": err.Error(),
		}, false
	}
	timeout := boundedDuration(args, "timeout_ms", 1000, 600000, defaultTimeout)
	outputLimit := boundedInt(args, "output_limit_bytes", 1, 1024*1024, defaultOutputLimit)

	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.CommandContext(runCtx, executable, argv[1:]...)
	cmd.Dir = cwd
	cmd.Env = e.commandEnv()
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
				"timeout_ms":     int(timeout.Milliseconds()),
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

func (e *Executor) commandEnv() []string {
	env := os.Environ()
	pathSet := false
	for index, entry := range env {
		if strings.HasPrefix(entry, "PATH=") {
			env[index] = "PATH=" + e.toolPath
			pathSet = true
			break
		}
	}
	if !pathSet {
		env = append(env, "PATH="+e.toolPath)
	}
	return env
}

func (e *Executor) lookupExecutable(name, cwd string) (string, error) {
	if strings.ContainsAny(name, `/\`) {
		return e.resolvePathExecutable(name, cwd)
	}
	for _, dir := range filepath.SplitList(e.toolPath) {
		if strings.TrimSpace(dir) == "" {
			continue
		}
		candidate := filepath.Join(dir, name)
		info, err := os.Stat(candidate)
		if err != nil || info.IsDir() || info.Mode().Perm()&0o111 == 0 {
			continue
		}
		return candidate, nil
	}
	return "", fmt.Errorf("executable %q not found on helper tool PATH", name)
}

func (e *Executor) resolvePathExecutable(name, cwd string) (string, error) {
	candidate := name
	if !filepath.IsAbs(candidate) {
		candidate = filepath.Join(cwd, candidate)
	}
	resolved := filepath.Clean(candidate)
	if !pathInside(resolved, e.workspaceRoot) {
		return "", fmt.Errorf("executable path outside workspace root")
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return "", err
	}
	if info.IsDir() || info.Mode().Perm()&0o111 == 0 {
		return "", fmt.Errorf("executable %q is not executable", name)
	}
	return resolved, nil
}

func normalizedToolPath(current string) string {
	seen := map[string]bool{}
	entries := make([]string, 0, len(filepath.SplitList(current))+8)
	add := func(path string) {
		trimmed := strings.TrimSpace(path)
		if trimmed == "" || seen[trimmed] {
			return
		}
		seen[trimmed] = true
		entries = append(entries, trimmed)
	}

	for _, entry := range filepath.SplitList(current) {
		add(entry)
	}
	for _, entry := range defaultToolPathEntries() {
		add(entry)
	}
	return strings.Join(entries, string(os.PathListSeparator))
}

func defaultToolPathEntries() []string {
	entries := []string{
		"/opt/homebrew/bin",
		"/opt/homebrew/sbin",
		"/usr/local/bin",
		"/usr/local/sbin",
		"/usr/bin",
		"/bin",
		"/usr/sbin",
		"/sbin",
	}
	if home, err := os.UserHomeDir(); err == nil && strings.TrimSpace(home) != "" {
		entries = append(entries, filepath.Join(home, ".local", "bin"), filepath.Join(home, "go", "bin"))
	}
	return entries
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
		return allowedGitArgs(argv[1:])
	case "gh":
		return nil
	default:
		return fmt.Errorf("unsupported_executable")
	}
}

func allowedGitArgs(argv []string) error {
	for index := 0; index < len(argv); index++ {
		arg := argv[index]
		switch {
		case arg == "-C":
			return fmt.Errorf("git_path_override_denied")
		case strings.HasPrefix(arg, "--git-dir"):
			return fmt.Errorf("git_path_override_denied")
		case strings.HasPrefix(arg, "--work-tree"):
			return fmt.Errorf("git_path_override_denied")
		case arg == "-c":
			if index+1 < len(argv) && configOverridesWorkTree(argv[index+1]) {
				return fmt.Errorf("git_path_override_denied")
			}
		case strings.HasPrefix(arg, "--config-env="):
			if configEnvOverridesWorkTree(strings.TrimPrefix(arg, "--config-env=")) {
				return fmt.Errorf("git_path_override_denied")
			}
		case arg == "--config-env":
			if index+1 < len(argv) && configEnvOverridesWorkTree(argv[index+1]) {
				return fmt.Errorf("git_path_override_denied")
			}
		}
	}
	if gitConfigTargetsWorkTree(argv) {
		return fmt.Errorf("git_path_override_denied")
	}
	return nil
}

func configOverridesWorkTree(value string) bool {
	key, _, ok := strings.Cut(value, "=")
	return ok && strings.EqualFold(strings.TrimSpace(key), "core.worktree")
}

func configEnvOverridesWorkTree(value string) bool {
	key, _, ok := strings.Cut(value, "=")
	return ok && strings.EqualFold(strings.TrimSpace(key), "core.worktree")
}

func gitConfigTargetsWorkTree(argv []string) bool {
	subcommandIndex := -1
	for index, arg := range argv {
		if arg == "--" {
			break
		}
		if strings.HasPrefix(arg, "-") {
			continue
		}
		subcommandIndex = index
		break
	}
	if subcommandIndex == -1 || argv[subcommandIndex] != "config" {
		return false
	}
	for _, arg := range argv[subcommandIndex+1:] {
		if arg == "--" {
			continue
		}
		if strings.HasPrefix(arg, "-") {
			continue
		}
		return strings.EqualFold(strings.TrimSpace(arg), "core.worktree")
	}
	return false
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
