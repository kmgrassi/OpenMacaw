package tools

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/kmgrassi/local-runtime-helper/internal/runner"
)

func TestShellExecRunsArgvInWorkspaceRoot(t *testing.T) {
	root := t.TempDir()
	executor, err := NewExecutor(root)
	if err != nil {
		t.Fatalf("NewExecutor() error = %v", err)
	}

	result := executor.Execute(context.Background(), runner.ToolCallRequest{
		ToolCallID: "call-shell",
		Name:       "shell.exec",
		Arguments: map[string]any{
			"argv": []any{"printf", "openmacaw-tool-eval"},
		},
	})
	if !result.Success {
		t.Fatalf("result.Success = false, output = %#v", result.Output)
	}
	output := result.Output.(map[string]any)
	if output["stdout"] != "openmacaw-tool-eval" {
		t.Fatalf("stdout = %#v, want %q", output["stdout"], "openmacaw-tool-eval")
	}
	if output["exit_code"] != 0 {
		t.Fatalf("exit_code = %#v, want 0", output["exit_code"])
	}
}

func TestShellExecConfinesCWDToWorkspaceRoot(t *testing.T) {
	executor, err := NewExecutor(t.TempDir())
	if err != nil {
		t.Fatalf("NewExecutor() error = %v", err)
	}

	result := executor.Execute(context.Background(), runner.ToolCallRequest{
		ToolCallID: "call-escape",
		Name:       "shell.exec",
		Arguments: map[string]any{
			"argv": []any{"echo", "hi"},
			"cwd":  "../../../etc",
		},
	})
	if result.Success {
		t.Fatalf("result.Success = true, want false for a cwd outside the workspace root")
	}
}

func TestRepoReadFileUsesRoutedWorkspaceRoot(t *testing.T) {
	root := t.TempDir()
	repo := filepath.Join(root, "openmacaw")
	if err := os.Mkdir(repo, 0o755); err != nil {
		t.Fatalf("Mkdir() error = %v", err)
	}
	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("# OpenMacaw\n"), 0o644); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	executor, err := NewExecutor(root)
	if err != nil {
		t.Fatalf("NewExecutor() error = %v", err)
	}

	result := executor.Execute(context.Background(), runner.ToolCallRequest{
		ToolCallID: "call-repo-read",
		Name:       "repo.read_file",
		Arguments: map[string]any{
			"path":         "README.md",
			"workspace_id": "workspace-1",
		},
		Context: runner.ToolExecutionContext{
			"workspace_root": repo,
		},
	})
	if !result.Success {
		t.Fatalf("result.Success = false, output = %#v", result.Output)
	}
	output := result.Output.(map[string]any)
	if output["path"] != "README.md" {
		t.Fatalf("path = %#v, want README.md", output["path"])
	}
	if output["content"] != "# OpenMacaw\n" {
		t.Fatalf("content = %#v, want README heading", output["content"])
	}
}

func TestRepoReadFileRejectsRoutedWorkspaceOutsideRoot(t *testing.T) {
	executor, err := NewExecutor(t.TempDir())
	if err != nil {
		t.Fatalf("NewExecutor() error = %v", err)
	}

	result := executor.Execute(context.Background(), runner.ToolCallRequest{
		ToolCallID: "call-repo-escape",
		Name:       "repo.read_file",
		Arguments:  map[string]any{"path": "README.md"},
		Context: runner.ToolExecutionContext{
			"workspace_root": t.TempDir(),
		},
	})
	if result.Success {
		t.Fatalf("result.Success = true, want false for route outside helper workspace root")
	}
}

func TestRepoReadFileAllowsRepositoryPathInsideWorkspaceRoot(t *testing.T) {
	root := t.TempDir()
	repo := filepath.Join(root, "openmacaw")
	if err := os.Mkdir(repo, 0o755); err != nil {
		t.Fatalf("Mkdir() error = %v", err)
	}
	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("# Routed\n"), 0o644); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	executor, err := NewExecutor(root)
	if err != nil {
		t.Fatalf("NewExecutor() error = %v", err)
	}

	result := executor.Execute(context.Background(), runner.ToolCallRequest{
		ToolCallID: "call-repo-read",
		Name:       "repo.read_file",
		Arguments: map[string]any{
			"path":            "README.md",
			"repository_path": repo,
		},
		Context: runner.ToolExecutionContext{
			"workspace_root": root,
		},
	})
	if !result.Success {
		t.Fatalf("result.Success = false, output = %#v", result.Output)
	}
	output := result.Output.(map[string]any)
	if output["content"] != "# Routed\n" {
		t.Fatalf("content = %#v, want routed repository content", output["content"])
	}
}

func TestRepoReadFileTruncatesAtUTF8Boundary(t *testing.T) {
	root := t.TempDir()
	repo := filepath.Join(root, "openmacaw")
	if err := os.Mkdir(repo, 0o755); err != nil {
		t.Fatalf("Mkdir() error = %v", err)
	}
	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("ab€z\n"), 0o644); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	executor, err := NewExecutor(root)
	if err != nil {
		t.Fatalf("NewExecutor() error = %v", err)
	}

	result := executor.Execute(context.Background(), runner.ToolCallRequest{
		ToolCallID: "call-repo-read",
		Name:       "repo.read_file",
		Arguments: map[string]any{
			"path":       "README.md",
			"byte_limit": 4,
		},
		Context: runner.ToolExecutionContext{
			"workspace_root": repo,
		},
	})
	if !result.Success {
		t.Fatalf("result.Success = false, output = %#v", result.Output)
	}
	output := result.Output.(map[string]any)
	if output["content"] != "ab" {
		t.Fatalf("content = %#v, want UTF-8 boundary prefix", output["content"])
	}
	if output["bytes_read"] != 2 {
		t.Fatalf("bytes_read = %#v, want 2", output["bytes_read"])
	}
	if output["truncated"] != true {
		t.Fatalf("truncated = %#v, want true", output["truncated"])
	}
}

func TestGitRunExecutesInsideWorkspaceRoot(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	root := t.TempDir()
	canonicalRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatalf("EvalSymlinks() error = %v", err)
	}
	repo := filepath.Join(root, "repo")
	if err := runGit(root, "init", repo); err != nil {
		t.Fatalf("git init: %v", err)
	}
	canonicalRepo, err := filepath.EvalSymlinks(repo)
	if err != nil {
		t.Fatalf("EvalSymlinks() repo error = %v", err)
	}

	executor, err := NewExecutor(root)
	if err != nil {
		t.Fatalf("NewExecutor() error = %v", err)
	}

	result := executor.Execute(context.Background(), runner.ToolCallRequest{
		ToolCallID: "call-1",
		Name:       "git.run",
		Arguments: map[string]any{
			"command": "git status --short",
			"cwd":     "repo",
		},
	})
	if !result.Success {
		t.Fatalf("result.Success = false, output = %#v", result.Output)
	}
	output := result.Output.(map[string]any)
	if output["workspace_root"] != canonicalRoot {
		t.Fatalf("workspace_root = %#v, want %q", output["workspace_root"], canonicalRoot)
	}
	if output["cwd"] != canonicalRepo {
		t.Fatalf("cwd = %#v, want %q", output["cwd"], canonicalRepo)
	}
}

func TestGitRunRejectsCommandsOutsidePolicy(t *testing.T) {
	executor, err := NewExecutor(t.TempDir())
	if err != nil {
		t.Fatalf("NewExecutor() error = %v", err)
	}

	result := executor.Execute(context.Background(), runner.ToolCallRequest{
		ToolCallID: "call-1",
		Name:       "git.run",
		Arguments:  map[string]any{"command": "rm -rf /"},
	})
	if result.Success {
		t.Fatalf("result.Success = true, output = %#v", result.Output)
	}
	output := result.Output.(map[string]any)
	if output["reason"] != "unsupported_executable" {
		t.Fatalf("reason = %#v", output["reason"])
	}
}

func TestGitRunRejectsPathOverrideFlags(t *testing.T) {
	executor, err := NewExecutor(t.TempDir())
	if err != nil {
		t.Fatalf("NewExecutor() error = %v", err)
	}

	testCases := []struct {
		name    string
		command string
	}{
		{name: "short -C", command: "git -C /tmp status"},
		{name: "long --git-dir", command: "git --git-dir=/tmp/.git status"},
		{name: "long --work-tree", command: "git --work-tree=/tmp status"},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			result := executor.Execute(context.Background(), runner.ToolCallRequest{
				ToolCallID: "call-1",
				Name:       "git.run",
				Arguments: map[string]any{
					"command": testCase.command,
				},
			})
			if result.Success {
				t.Fatalf("result.Success = true, output = %#v", result.Output)
			}
			output := result.Output.(map[string]any)
			if output["reason"] != "git_path_override_denied" {
				t.Fatalf("reason = %#v", output["reason"])
			}
		})
	}
}

func TestGitRunRejectsCWDOutsideWorkspaceRoot(t *testing.T) {
	executor, err := NewExecutor(t.TempDir())
	if err != nil {
		t.Fatalf("NewExecutor() error = %v", err)
	}

	result := executor.Execute(context.Background(), runner.ToolCallRequest{
		ToolCallID: "call-1",
		Name:       "git.run",
		Arguments: map[string]any{
			"command": "git status",
			"cwd":     "/tmp",
		},
	})
	if result.Success {
		t.Fatalf("result.Success = true, output = %#v", result.Output)
	}
	output := result.Output.(map[string]any)
	if output["error"] != "invalid_arguments" {
		t.Fatalf("error = %#v", output["error"])
	}
}

func TestGitRunSupportsQuotedCommandArguments(t *testing.T) {
	argv, err := splitCommand(`gh pr comment 1 --body "hello world"`)
	if err != nil {
		t.Fatalf("splitCommand() error = %v", err)
	}
	want := []string{"gh", "pr", "comment", "1", "--body", "hello world"}
	if len(argv) != len(want) {
		t.Fatalf("argv = %#v", argv)
	}
	for i := range want {
		if argv[i] != want[i] {
			t.Fatalf("argv = %#v", argv)
		}
	}
}

func runGit(cwd string, args ...string) error {
	cmd := exec.Command("git", args...)
	cmd.Dir = cwd
	return cmd.Run()
}
