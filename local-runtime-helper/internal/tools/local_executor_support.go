package tools

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/kmgrassi/local-runtime-helper/internal/runner"
)

func (e *Executor) resolveCWD(cwd string) (string, error) {
	if strings.TrimSpace(cwd) == "" {
		cwd = "."
	}
	var candidate string
	if workspacePath, ok := e.virtualWorkspacePath(cwd); ok {
		candidate = workspacePath
	} else if filepath.IsAbs(cwd) {
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

func (e *Executor) virtualWorkspacePath(path string) (string, bool) {
	cleaned := filepath.Clean(path)
	if cleaned == "/workspace" {
		return e.workspaceRoot, true
	}
	if strings.HasPrefix(cleaned, "/workspace/") {
		return filepath.Join(e.workspaceRoot, strings.TrimPrefix(cleaned, "/workspace/")), true
	}
	return "", false
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
