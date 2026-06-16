package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

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

func (e *Executor) repoList(args map[string]any, context runner.ToolExecutionContext) (map[string]any, bool) {
	repoRoot, err := e.resolveRepoRoot(context, args)
	if err != nil {
		return errorOutput(err), false
	}
	path := stringArg(args, "path")
	if strings.TrimSpace(path) == "" {
		path = "."
	}
	maxDepth := boundedInt(args, "max_depth", 0, maxListDepth, defaultListDepth)
	limit := boundedInt(args, "limit", 1, maxListLimit, defaultListLimit)
	directory, rel, err := e.resolveRepoPath(repoRoot, path, allowDirectory)
	if err != nil {
		return errorOutput(err), false
	}
	entries, err := listRepoEntries(repoRoot, directory, maxDepth, limit)
	if err != nil {
		return errorOutput(err), false
	}
	return map[string]any{
		"ok":           true,
		"workspace_id": stringArg(args, "workspace_id"),
		"path":         rel,
		"entries":      entries,
	}, true
}

func (e *Executor) repoReadFile(args map[string]any, context runner.ToolExecutionContext) (map[string]any, bool) {
	repoRoot, err := e.resolveRepoRoot(context, args)
	if err != nil {
		return errorOutput(err), false
	}
	path := strings.TrimSpace(stringArg(args, "path"))
	if path == "" {
		return errorOutput(fmt.Errorf("path is required")), false
	}
	byteLimit := boundedInt(args, "byte_limit", 1, maxFileLimit, defaultFileLimit)
	filePath, rel, err := e.resolveRepoPath(repoRoot, path, allowFile)
	if err != nil {
		return errorOutput(err), false
	}
	content, bytesRead, truncated, err := readBoundedTextFile(filePath, byteLimit)
	if err != nil {
		return errorOutput(err), false
	}
	return map[string]any{
		"ok":           true,
		"workspace_id": stringArg(args, "workspace_id"),
		"path":         rel,
		"content":      content,
		"bytes_read":   bytesRead,
		"truncated":    truncated,
	}, true
}

func (e *Executor) repoSearch(ctx context.Context, args map[string]any, context runner.ToolExecutionContext) (map[string]any, bool) {
	repoRoot, err := e.resolveRepoRoot(context, args)
	if err != nil {
		return errorOutput(err), false
	}
	query := strings.TrimSpace(stringArg(args, "query"))
	if query == "" {
		return errorOutput(fmt.Errorf("query is required")), false
	}
	path := stringArg(args, "path")
	if strings.TrimSpace(path) == "" {
		path = "."
	}
	limit := boundedInt(args, "limit", 1, maxListLimit, defaultListLimit)
	snippetChars := boundedInt(args, "snippet_chars", 40, maxSnippet, defaultSnippet)
	searchRoot, rel, err := e.resolveRepoPath(repoRoot, path, allowFileOrDirectory)
	if err != nil {
		return errorOutput(err), false
	}
	matches, err := e.searchRepo(ctx, repoRoot, rel, searchRoot, query, limit, snippetChars)
	if err != nil {
		return errorOutput(err), false
	}
	return map[string]any{
		"ok":           true,
		"workspace_id": stringArg(args, "workspace_id"),
		"query":        query,
		"matches":      matches,
	}, true
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

type repoPathKind int

const (
	allowFile repoPathKind = iota
	allowDirectory
	allowFileOrDirectory
)

func (e *Executor) resolveRepoRoot(context runner.ToolExecutionContext, args map[string]any) (string, error) {
	candidates := []string{
		stringArg(args, "cwd"),
		stringArg(args, "repository_path"),
		stringArg(args, "workspace_root"),
		contextString(context, "workspace_root"),
		contextString(context, "workspaceRoot"),
	}
	for _, candidate := range candidates {
		if strings.TrimSpace(candidate) == "" {
			continue
		}
		resolved, err := canonicalDirectory(candidate)
		if err != nil {
			return "", err
		}
		if !pathInside(resolved, e.workspaceRoot) {
			return "", fmt.Errorf("repository path outside workspace root")
		}
		return resolved, nil
	}
	return e.workspaceRoot, nil
}

func (e *Executor) resolveRepoPath(repoRoot, requested string, kind repoPathKind) (string, string, error) {
	if err := validateRelativePath(requested); err != nil {
		return "", "", err
	}
	candidate := filepath.Join(repoRoot, requested)
	resolved, err := filepath.EvalSymlinks(candidate)
	if err != nil {
		return "", "", err
	}
	if !pathInside(resolved, repoRoot) {
		return "", "", fmt.Errorf("path outside repository")
	}
	rel, err := filepath.Rel(repoRoot, resolved)
	if err != nil {
		return "", "", err
	}
	if rel == "" {
		rel = "."
	}
	if denyReadPath(rel) {
		return "", "", fmt.Errorf("denied path")
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return "", "", err
	}
	switch kind {
	case allowFile:
		if !info.Mode().IsRegular() {
			return "", "", fmt.Errorf("path is not a file")
		}
	case allowDirectory:
		if !info.IsDir() {
			return "", "", fmt.Errorf("path is not a directory")
		}
	case allowFileOrDirectory:
		if !info.Mode().IsRegular() && !info.IsDir() {
			return "", "", fmt.Errorf("path is not a file or directory")
		}
	}
	return resolved, filepath.ToSlash(rel), nil
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

func listRepoEntries(repoRoot, directory string, maxDepth, limit int) ([]map[string]any, error) {
	var entries []map[string]any
	err := walkRepoEntries(repoRoot, directory, 0, maxDepth, limit, &entries)
	if err != nil {
		return nil, err
	}
	sort.Slice(entries, func(i, j int) bool {
		left, _ := entries[i]["path"].(string)
		right, _ := entries[j]["path"].(string)
		return left < right
	})
	return entries, nil
}

func walkRepoEntries(repoRoot, directory string, depth, maxDepth, limit int, entries *[]map[string]any) error {
	if len(*entries) >= limit {
		return nil
	}
	children, err := os.ReadDir(directory)
	if err != nil {
		return err
	}
	sort.Slice(children, func(i, j int) bool { return children[i].Name() < children[j].Name() })
	for _, child := range children {
		if len(*entries) >= limit {
			return nil
		}
		if ignoredEntry(child.Name()) {
			continue
		}
		childPath := filepath.Join(directory, child.Name())
		info, err := child.Info()
		if err != nil {
			continue
		}
		if info.Mode()&fs.ModeSymlink != 0 {
			continue
		}
		rel, err := filepath.Rel(repoRoot, childPath)
		if err != nil || denyReadPath(rel) {
			continue
		}
		entryType := "file"
		if info.IsDir() {
			entryType = "directory"
		}
		*entries = append(*entries, map[string]any{
			"path": filepath.ToSlash(rel),
			"type": entryType,
			"size": info.Size(),
		})
		if info.IsDir() && depth < maxDepth {
			if err := walkRepoEntries(repoRoot, childPath, depth+1, maxDepth, limit, entries); err != nil {
				return err
			}
		}
	}
	return nil
}

func readBoundedTextFile(path string, byteLimit int) (string, int, bool, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", 0, false, err
	}
	defer file.Close()

	content, err := io.ReadAll(io.LimitReader(file, int64(byteLimit+1)))
	if err != nil {
		return "", 0, false, err
	}
	truncated := len(content) > byteLimit
	if truncated {
		content = content[:byteLimit]
		content = trimToValidUTF8(content)
	}
	if !utf8.Valid(content) {
		return "", 0, false, fmt.Errorf("non-utf8 file")
	}
	return string(content), len(content), truncated, nil
}

func trimToValidUTF8(content []byte) []byte {
	for len(content) > 0 && !utf8.Valid(content) {
		content = content[:len(content)-1]
	}
	return content
}

func (e *Executor) searchRepo(ctx context.Context, repoRoot, rel, searchRoot, query string, limit, snippetChars int) ([]map[string]any, error) {
	rg, err := exec.LookPath("rg")
	if err != nil {
		return nil, fmt.Errorf("ripgrep not found")
	}
	searchPath := rel
	if searchPath == "." {
		searchPath = "."
	}
	runCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(
		runCtx,
		rg,
		"--json",
		"--line-number",
		"--column",
		"--color",
		"never",
		"--hidden",
		"--glob",
		"!.git",
		"--glob",
		"!.env*",
		"--max-count",
		fmt.Sprint(limit),
		"--",
		query,
		searchPath,
	)
	cmd.Dir = repoRoot
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err = cmd.Run()
	if err != nil {
		var exitErr *exec.ExitError
		if !errors.As(err, &exitErr) || exitErr.ExitCode() != 1 {
			if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
				return nil, fmt.Errorf("ripgrep timed out")
			}
			return nil, fmt.Errorf("search failed: %s", strings.TrimSpace(stderr.String()))
		}
	}
	_ = searchRoot
	return parseRGJSON(stdout.String(), limit, snippetChars), nil
}

func parseRGJSON(output string, limit, snippetChars int) []map[string]any {
	var matches []map[string]any
	for _, line := range strings.Split(output, "\n") {
		if len(matches) >= limit {
			break
		}
		if strings.TrimSpace(line) == "" {
			continue
		}
		var payload map[string]any
		if err := json.Unmarshal([]byte(line), &payload); err != nil {
			continue
		}
		if payload["type"] != "match" {
			continue
		}
		data, ok := payload["data"].(map[string]any)
		if !ok {
			continue
		}
		path := nestedText(data, "path")
		if denyReadPath(path) {
			continue
		}
		lineText := nestedText(data, "lines")
		match := map[string]any{
			"path":    strings.TrimPrefix(filepath.ToSlash(path), "./"),
			"line":    intValue(data["line_number"]),
			"column":  firstSubmatchColumn(data),
			"snippet": boundedSnippet(lineText, snippetChars),
		}
		matches = append(matches, match)
	}
	return matches
}

func nestedText(data map[string]any, key string) string {
	if nested, ok := data[key].(map[string]any); ok {
		if text, ok := nested["text"].(string); ok {
			return text
		}
	}
	return ""
}

func firstSubmatchColumn(data map[string]any) any {
	submatches, ok := data["submatches"].([]any)
	if !ok || len(submatches) == 0 {
		return nil
	}
	first, ok := submatches[0].(map[string]any)
	if !ok {
		return nil
	}
	start := intValue(first["start"])
	if start == nil {
		return nil
	}
	return start.(int) + 1
}

func intValue(value any) any {
	switch v := value.(type) {
	case int:
		return v
	case float64:
		return int(v)
	default:
		return nil
	}
}

func boundedSnippet(line string, snippetChars int) string {
	line = strings.TrimRight(line, "\r\n")
	runes := []rune(line)
	if len(runes) <= snippetChars {
		return line
	}
	return string(runes[:snippetChars])
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

func validateRelativePath(path string) error {
	if strings.Contains(path, "\x00") {
		return fmt.Errorf("path contains null byte")
	}
	if filepath.IsAbs(path) {
		return fmt.Errorf("path must be relative")
	}
	for _, segment := range strings.FieldsFunc(path, func(r rune) bool { return r == '/' || r == '\\' }) {
		if segment == ".." {
			return fmt.Errorf("path traversal is not allowed")
		}
	}
	return nil
}

func denyReadPath(path string) bool {
	if path == "" {
		return true
	}
	path = filepath.ToSlash(path)
	for _, segment := range strings.Split(path, "/") {
		if segment == ".git" {
			return true
		}
	}
	base := strings.ToLower(filepath.Base(path))
	switch base {
	case ".env", ".npmrc", ".netrc", "id_rsa", "id_ed25519", "credentials", "credentials.json":
		return true
	}
	if strings.HasPrefix(base, ".env.") ||
		strings.HasSuffix(base, ".pem") ||
		strings.HasSuffix(base, ".key") ||
		strings.HasSuffix(base, ".p12") ||
		strings.HasSuffix(base, ".pfx") ||
		strings.Contains(base, "secret") ||
		strings.Contains(base, "credential") {
		return true
	}
	return false
}

func ignoredEntry(entry string) bool {
	return entry == ".git" || strings.HasPrefix(entry, ".env")
}

func stringArg(args map[string]any, key string) string {
	if value, ok := args[key].(string); ok {
		return value
	}
	return ""
}

func contextString(context runner.ToolExecutionContext, key string) string {
	if context == nil {
		return ""
	}
	if value, ok := context[key].(string); ok {
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
