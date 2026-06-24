package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/kmgrassi/local-runtime-helper/internal/config"
)

func TestRegisterWritesConfigWithoutPrintingToken(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "runtime.toml")
	token := "lrt_once_secret"

	cmd := exec.Command(
		"go",
		"run",
		".",
		"register",
		"--endpoint", "wss://example.test/relay/ws",
		"--workspace", "ws_123",
		"--machine-id", "machine-123",
		"--name", "Kevin MBP",
		"--token", token,
		"--workspace-root", "/tmp",
		"--openai-compatible-endpoint", "http://localhost:11434/v1",
		"--openai-compatible-model", "qwen3-coder:30b",
		"--tool-call-capability", "native_tools",
		"--config", configPath,
	)

	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("register failed: %v\n%s", err, output)
	}

	if strings.Contains(string(output), token) {
		t.Fatalf("register output printed token: %s", output)
	}
	if !strings.Contains(string(output), configPath) {
		t.Fatalf("register output = %q, want config path", output)
	}

	data, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	if !strings.Contains(string(data), `token = "`+token+`"`) {
		t.Fatalf("config did not contain token:\n%s", data)
	}
	if !strings.Contains(string(data), `workspace_root = "/tmp"`) {
		t.Fatalf("config did not contain workspace root:\n%s", data)
	}
	if !strings.Contains(string(data), `id = "machine-123"`) {
		t.Fatalf("config did not contain machine id:\n%s", data)
	}
	if !strings.Contains(string(data), `[runner.openai_compatible]`) {
		t.Fatalf("config did not contain openai-compatible runner:\n%s", data)
	}
	if !strings.Contains(string(data), `endpoint = "http://localhost:11434/v1"`) {
		t.Fatalf("config did not contain runner endpoint:\n%s", data)
	}
	if !strings.Contains(string(data), `model = "qwen3-coder:30b"`) {
		t.Fatalf("config did not contain runner model:\n%s", data)
	}

	info, err := os.Stat(configPath)
	if err != nil {
		t.Fatalf("stat config: %v", err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("config permissions = %v, want 0600", got)
	}
}

func TestRegisterRequiresForceForExistingConfig(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "runtime.toml")
	initial := registerCommand(t, configPath, "Kevin MBP", "lrt_once_initial")
	if output, err := initial.CombinedOutput(); err != nil {
		t.Fatalf("initial register failed: %v\n%s", err, output)
	}

	withoutForce := registerCommand(t, configPath, "Replacement", "lrt_once_replacement")
	output, err := withoutForce.CombinedOutput()
	if err == nil {
		t.Fatalf("register without --force succeeded unexpectedly:\n%s", output)
	}
	if strings.Contains(string(output), "lrt_once_replacement") {
		t.Fatalf("register error printed token: %s", output)
	}
	if !strings.Contains(string(output), "pass --force") {
		t.Fatalf("register output = %q, want --force guidance", output)
	}

	withForce := registerCommand(t, configPath, "Replacement", "lrt_once_replacement", "--force")
	output, err = withForce.CombinedOutput()
	if err != nil {
		t.Fatalf("register with --force failed: %v\n%s", err, output)
	}
	if strings.Contains(string(output), "lrt_once_replacement") {
		t.Fatalf("register output printed token: %s", output)
	}

	data, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	if !strings.Contains(string(data), `display_name = "Replacement"`) {
		t.Fatalf("--force did not replace config:\n%s", data)
	}
	if !strings.Contains(string(data), `token = "lrt_once_replacement"`) {
		t.Fatalf("--force did not write replacement token:\n%s", data)
	}
}

func registerCommand(t *testing.T, configPath, displayName, token string, extraArgs ...string) *exec.Cmd {
	t.Helper()

	args := []string{
		"run",
		".",
		"register",
		"--endpoint", "wss://example.test/relay/ws",
		"--workspace", "ws_123",
		"--name", displayName,
		"--token", token,
		"--openai-compatible-endpoint", "http://localhost:11434/v1",
		"--openai-compatible-model", "qwen3-coder:30b",
		"--config", configPath,
	}
	args = append(args, extraArgs...)
	return exec.Command("go", args...)
}

func TestStartFailsWithoutConfig(t *testing.T) {
	missingConfigPath := filepath.Join(t.TempDir(), "missing-runtime.toml")
	cmd := exec.Command("go", "run", ".", "start", "--config", missingConfigPath)
	output, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("start succeeded unexpectedly:\n%s", output)
	}
	out := string(output)
	// Without a config file, start should fail with a config load error.
	if !strings.Contains(out, "load config") {
		t.Fatalf("start output = %q, want config load error", out)
	}
}

func TestBuildRunnersAdvertisesOnlyInitializedKinds(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		runners config.RunnerConfigs
		want    []string
	}{
		{
			name: "openai_compatible only",
			runners: config.RunnerConfigs{
				OpenAICompatible: &config.OpenAICompatibleConfig{
					Endpoint: "http://127.0.0.1:11434/v1",
					Model:    "qwen3-coder:30b",
				},
			},
			want: []string{"openai_compatible"},
		},
		{
			name: "openclaw only",
			runners: config.RunnerConfigs{
				OpenClaw: &config.OpenClawConfig{
					Endpoint: "http://127.0.0.1:7100",
				},
			},
			want: []string{"openclaw"},
		},
		{
			name: "mixed openai_compatible and openclaw",
			runners: config.RunnerConfigs{
				OpenAICompatible: &config.OpenAICompatibleConfig{
					Endpoint: "http://127.0.0.1:11434/v1",
					Model:    "qwen3-coder:30b",
				},
				OpenClaw: &config.OpenClawConfig{
					Endpoint: "http://127.0.0.1:7100",
					APIKey:   "secret",
				},
			},
			want: []string{"openai_compatible", "openclaw"},
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			cfg := &config.Config{Runners: tc.runners}

			runners, kinds, _, err := buildRunners(cfg, nil)
			if err != nil {
				t.Fatalf("buildRunners returned error: %v", err)
			}
			if len(runners) != len(tc.want) {
				t.Fatalf("runners count = %d, want %d", len(runners), len(tc.want))
			}
			if !reflect.DeepEqual(kinds, tc.want) {
				t.Fatalf("activeRunnerKinds = %v, want %v", kinds, tc.want)
			}

			for i, kind := range tc.want {
				if got := runners[i].Kind(); got != kind {
					t.Fatalf("runners[%d].Kind() = %q, want %q", i, got, kind)
				}
			}
		})
	}
}

func TestBuildRunnersReturnsErrorOnInvalidConfig(t *testing.T) {
	t.Parallel()

	cfg := &config.Config{
		Runners: config.RunnerConfigs{
			OpenClaw: &config.OpenClawConfig{Endpoint: ""},
		},
	}

	if _, _, _, err := buildRunners(cfg, nil); err == nil {
		t.Fatal("buildRunners with empty openclaw endpoint returned nil error; want surfaced error")
	}
}

func TestVersionCanBeInjectedWithLdflags(t *testing.T) {
	cmd := exec.Command(
		"go",
		"run",
		"-ldflags=-X main.version=1.2.3-test",
		".",
		"version",
	)
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("version command failed: %v\n%s", err, output)
	}
	if got, want := strings.TrimSpace(string(output)), "local-runtime-helper 1.2.3-test"; got != want {
		t.Fatalf("version output = %q, want %q", got, want)
	}
}
