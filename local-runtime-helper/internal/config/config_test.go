package config

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type failingWriter struct{}

func (failingWriter) Write(_ []byte) (int, error) {
	return 0, errors.New("boom")
}

const validConfig = `
[machine]
display_name = "kevin-mbp"

[cloud]
endpoint = "wss://platform.example.com/worker-bridge/relay/ws"
workspace_id = "ws_123"
token = "lrh_test"

[runner.openai_compatible]
endpoint = "http://127.0.0.1:11434/v1"
api_key = "ollama"
model = "qwen2.5-coder:latest"

[runner.openclaw]
endpoint = "http://127.0.0.1:7100"
api_key = "openclaw-local"
`

func TestParseValidConfig(t *testing.T) {
	t.Setenv(EnvCloudEndpoint, "")
	t.Setenv(EnvCloudToken, "")

	cfg, err := Parse([]byte(validConfig))
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}

	if cfg.Machine.DisplayName != "kevin-mbp" {
		t.Fatalf("Machine.DisplayName = %q", cfg.Machine.DisplayName)
	}
	if cfg.Cloud.Endpoint != "wss://platform.example.com/worker-bridge/relay/ws" {
		t.Fatalf("Cloud.Endpoint = %q", cfg.Cloud.Endpoint)
	}
	if cfg.Cloud.WorkspaceID != "ws_123" {
		t.Fatalf("Cloud.WorkspaceID = %q", cfg.Cloud.WorkspaceID)
	}
	if cfg.Cloud.Token != "lrh_test" {
		t.Fatalf("Cloud.Token = %q", cfg.Cloud.Token)
	}
	if cfg.Runners.OpenAICompatible == nil {
		t.Fatal("OpenAICompatible runner is nil")
	}
	if cfg.Runners.OpenAICompatible.Endpoint != "http://127.0.0.1:11434/v1" {
		t.Fatalf("OpenAICompatible.Endpoint = %q", cfg.Runners.OpenAICompatible.Endpoint)
	}
	if cfg.Runners.OpenAICompatible.APIKey != "ollama" {
		t.Fatalf("OpenAICompatible.APIKey = %q", cfg.Runners.OpenAICompatible.APIKey)
	}
	if cfg.Runners.OpenAICompatible.Model != "qwen2.5-coder:latest" {
		t.Fatalf("OpenAICompatible.Model = %q", cfg.Runners.OpenAICompatible.Model)
	}
	if cfg.Runners.OpenClaw == nil {
		t.Fatal("OpenClaw runner is nil")
	}
	if cfg.Runners.OpenClaw.APIKey != "openclaw-local" {
		t.Fatalf("OpenClaw.APIKey = %q", cfg.Runners.OpenClaw.APIKey)
	}
}

func TestParseAppliesEnvOverrides(t *testing.T) {
	t.Setenv(EnvCloudEndpoint, "wss://override.example.com/relay")
	t.Setenv(EnvCloudToken, "lrh_override")

	cfg, err := Parse([]byte(validConfig))
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}

	if cfg.Cloud.Endpoint != "wss://override.example.com/relay" {
		t.Fatalf("Cloud.Endpoint = %q", cfg.Cloud.Endpoint)
	}
	if cfg.Cloud.Token != "lrh_override" {
		t.Fatalf("Cloud.Token = %q", cfg.Cloud.Token)
	}
}

func TestParseAcceptsMachineWorkspaceRoot(t *testing.T) {
	t.Setenv(EnvCloudEndpoint, "")
	t.Setenv(EnvCloudToken, "")

	root := t.TempDir()
	cfgText := strings.Replace(validConfig, `display_name = "kevin-mbp"`, `display_name = "kevin-mbp"`+"\n"+`workspace_root = "`+root+`"`, 1)
	cfg, err := Parse([]byte(cfgText))
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}
	if cfg.Machine.WorkspaceRoot != root {
		t.Fatalf("Machine.WorkspaceRoot = %q, want %q", cfg.Machine.WorkspaceRoot, root)
	}
}

func TestParseRejectsUnknownRunnerKind(t *testing.T) {
	t.Setenv(EnvCloudEndpoint, "")
	t.Setenv(EnvCloudToken, "")

	_, err := Parse([]byte(validConfig + `
[runner.unknown]
endpoint = "http://127.0.0.1:9999"
`))
	if err == nil {
		t.Fatal("Parse() error = nil")
	}
	if !strings.Contains(err.Error(), "unknown field(s): runner.unknown") {
		t.Fatalf("Parse() error = %v", err)
	}
}

func TestParseReturnsActionableValidationErrors(t *testing.T) {
	t.Setenv(EnvCloudEndpoint, "")
	t.Setenv(EnvCloudToken, "")

	_, err := Parse([]byte(`
[machine]
display_name = ""

[cloud]
endpoint = "https://platform.example.com/relay"
workspace_id = ""
token = ""
`))
	if err == nil {
		t.Fatal("Parse() error = nil")
	}

	var validationErr *ValidationError
	if !errors.As(err, &validationErr) {
		t.Fatalf("Parse() error type = %T, want *ValidationError", err)
	}
	got := err.Error()
	for _, want := range []string{
		"machine.display_name",
		"cloud.endpoint",
		"cloud.workspace_id",
		"cloud.token",
		"runner",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("Parse() error = %q, missing %q", got, want)
		}
	}
}

func TestResolvePath(t *testing.T) {
	t.Setenv(EnvConfigPath, "")
	t.Setenv("XDG_CONFIG_HOME", "/tmp/xdg")

	resolved, err := ResolvePath("")
	if err != nil {
		t.Fatalf("ResolvePath() error = %v", err)
	}
	if resolved != "/tmp/xdg/openmacaw/runtime.toml" {
		t.Fatalf("ResolvePath() = %q", resolved)
	}

	t.Setenv(EnvConfigPath, "/tmp/from-env.toml")
	resolved, err = ResolvePath("")
	if err != nil {
		t.Fatalf("ResolvePath() env error = %v", err)
	}
	if resolved != "/tmp/from-env.toml" {
		t.Fatalf("ResolvePath() env = %q", resolved)
	}
}

func TestLoadSetsResolvedPath(t *testing.T) {
	t.Setenv(EnvCloudEndpoint, "")
	t.Setenv(EnvCloudToken, "")
	t.Setenv(EnvConfigPath, "")

	dir := t.TempDir()
	configPath := filepath.Join(dir, "runtime.toml")
	if err := os.WriteFile(configPath, []byte(validConfig), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	cfg, err := Load(configPath)
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.Path != configPath {
		t.Fatalf("Path = %q", cfg.Path)
	}
}

func TestWriteCreatesOwnerOnlyConfigAndCreatedDir(t *testing.T) {
	path := filepath.Join(t.TempDir(), "openmacaw", "runtime.toml")
	writtenPath, err := Write(validRegistrationConfig(), WriteOptions{Path: path})
	if err != nil {
		t.Fatalf("Write() error = %v", err)
	}
	if writtenPath != path {
		t.Fatalf("Write() path = %q, want %q", writtenPath, path)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat config: %v", err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("config permissions = %v, want 0600", got)
	}

	dirInfo, err := os.Stat(filepath.Dir(path))
	if err != nil {
		t.Fatalf("stat config dir: %v", err)
	}
	if got := dirInfo.Mode().Perm(); got != 0o700 {
		t.Fatalf("created config dir permissions = %v, want 0700", got)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	for _, want := range []string{
		`display_name = "Kevin MBP"`,
		`endpoint = "wss://example.test/relay/ws"`,
		`workspace_id = "ws_123"`,
		`token = "lrt_once_123"`,
		"[runner.openai_compatible]",
		`endpoint = "http://localhost:11434/v1"`,
		`model = "qwen3-coder:30b"`,
		`tool_call_capability = "native_tools"`,
	} {
		if !strings.Contains(string(data), want) {
			t.Fatalf("config missing %q:\n%s", want, data)
		}
	}
}

func TestWriteDoesNotChmodExistingParentDir(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "shared")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatalf("Mkdir() error = %v", err)
	}

	path := filepath.Join(dir, "runtime.toml")
	if _, err := Write(validRegistrationConfig(), WriteOptions{Path: path}); err != nil {
		t.Fatalf("Write() error = %v", err)
	}

	dirInfo, err := os.Stat(dir)
	if err != nil {
		t.Fatalf("stat config dir: %v", err)
	}
	if got := dirInfo.Mode().Perm(); got != 0o755 {
		t.Fatalf("existing parent dir permissions = %v, want 0755", got)
	}
}

func TestRenderRegistrationTOMLReturnsEncodeErrors(t *testing.T) {
	_, err := renderRegistrationTOML(validRegistrationConfig())
	if err != nil {
		t.Fatalf("renderRegistrationTOML() unexpected error = %v", err)
	}

	err = writeRegistrationTOML(failingWriter{}, validRegistrationConfig())
	if err == nil {
		t.Fatal("writeRegistrationTOML() error = nil")
	}
	if !strings.Contains(err.Error(), "write registration TOML header") {
		t.Fatalf("writeRegistrationTOML() error = %v", err)
	}
}

func TestWriteRequiresOverwriteForExistingConfig(t *testing.T) {
	path := filepath.Join(t.TempDir(), "runtime.toml")
	if _, err := Write(validRegistrationConfig(), WriteOptions{Path: path}); err != nil {
		t.Fatalf("initial Write() error = %v", err)
	}

	_, err := Write(validRegistrationConfig(), WriteOptions{Path: path})
	if !errors.Is(err, ErrConfigExists) {
		t.Fatalf("Write() error = %v, want ErrConfigExists", err)
	}

	cfg := validRegistrationConfig()
	cfg.Machine.DisplayName = "Replacement"
	if _, err := Write(cfg, WriteOptions{Path: path, Overwrite: true}); err != nil {
		t.Fatalf("overwrite Write() error = %v", err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read overwritten config: %v", err)
	}
	if !strings.Contains(string(data), `display_name = "Replacement"`) {
		t.Fatalf("overwrite did not replace config:\n%s", data)
	}
}

func TestWriteValidatesRequiredFields(t *testing.T) {
	cfg := validRegistrationConfig()
	cfg.Cloud.Token = ""

	_, err := Write(cfg, WriteOptions{Path: filepath.Join(t.TempDir(), "runtime.toml")})
	if err == nil || !strings.Contains(err.Error(), "one-time token is required") {
		t.Fatalf("Write() error = %v, want token validation error", err)
	}
}

func TestExampleConfigParses(t *testing.T) {
	t.Setenv(EnvCloudEndpoint, "")
	t.Setenv(EnvCloudToken, "")

	data, err := os.ReadFile(filepath.Join("..", "..", "docs", "runtime.toml.example"))
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}

	cfg, err := Parse(data)
	if err != nil {
		t.Fatalf("Parse(example) error = %v", err)
	}
	if cfg.Runners.OpenAICompatible == nil {
		t.Fatal("example missing openai_compatible runner")
	}
	if cfg.Runners.OpenClaw == nil {
		t.Fatal("example missing openclaw runner")
	}
}

func validRegistrationConfig() Config {
	return Config{
		Machine: MachineConfig{DisplayName: "Kevin MBP"},
		Cloud: CloudConfig{
			Endpoint:    "wss://example.test/relay/ws",
			WorkspaceID: "ws_123",
			Token:       "lrt_once_123",
		},
		Runners: RunnerConfigs{
			OpenAICompatible: &OpenAICompatibleConfig{
				Endpoint:           "http://localhost:11434/v1",
				Model:              "qwen3-coder:30b",
				ToolCallCapability: "native_tools",
			},
		},
	}
}
