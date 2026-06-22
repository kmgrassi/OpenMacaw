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

type repoPathKind int

const (
	allowFile repoPathKind = iota
	allowDirectory
	allowFileOrDirectory
)

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
		childPath := filepath.Join(directory, child.Name())
		info, err := child.Info()
		if err != nil {
			continue
		}
		if info.Mode()&fs.ModeSymlink != 0 {
			continue
		}
		rel, err := filepath.Rel(repoRoot, childPath)
		if err != nil {
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
	rg, err := e.lookupExecutable("rg", repoRoot)
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
		"--max-count",
		fmt.Sprint(limit),
		"--",
		query,
		searchPath,
	)
	cmd.Dir = repoRoot
	cmd.Env = e.commandEnv()
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
