// Package config parses runtime.toml and validates the daemon's local runtime
// configuration.
package config

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/BurntSushi/toml"
)

const (
	defaultConfigSubpath = "openmacaw/runtime.toml"

	// EnvConfigPath overrides the default runtime.toml location.
	EnvConfigPath = "LOCAL_RUNTIME_CONFIG"
	// EnvCloudEndpoint overrides [cloud].endpoint.
	EnvCloudEndpoint = "LOCAL_RUNTIME_ENDPOINT"
	// EnvCloudToken overrides [cloud].token.
	EnvCloudToken = "LOCAL_RUNTIME_TOKEN"
)

// ErrConfigExists reports that runtime.toml already exists and overwrite was
// not requested.
var ErrConfigExists = errors.New("runtime config already exists")

// Config is the typed shape of runtime.toml.
type Config struct {
	Path    string        `toml:"-"`
	Machine MachineConfig `toml:"machine"`
	Cloud   CloudConfig   `toml:"cloud"`
	Runners RunnerConfigs `toml:"runner"`
}

// MachineConfig captures display/identity for this machine.
type MachineConfig struct {
	ID            string `toml:"id"`
	DisplayName   string `toml:"display_name"`
	WorkspaceRoot string `toml:"workspace_root"`
}

// CloudConfig captures how to reach the cloud orchestrator.
type CloudConfig struct {
	Endpoint    string `toml:"endpoint"`
	WorkspaceID string `toml:"workspace_id"`
	Token       string `toml:"token"`
}

// RunnerConfigs contains every runner kind supported by this helper.
type RunnerConfigs struct {
	OpenAICompatible *OpenAICompatibleConfig `toml:"openai_compatible"`
	OpenClaw         *OpenClawConfig         `toml:"openclaw"`
}

// OpenAICompatibleConfig configures an OpenAI-compatible local model endpoint.
type OpenAICompatibleConfig struct {
	Endpoint           string `toml:"endpoint"`
	APIKey             string `toml:"api_key"`
	Model              string `toml:"model"`
	ToolCallCapability string `toml:"tool_call_capability"`
}

// OpenClawConfig configures a local OpenClaw endpoint.
type OpenClawConfig struct {
	Endpoint string `toml:"endpoint"`
	APIKey   string `toml:"api_key"`
}

// WriteOptions controls how runtime.toml is written.
type WriteOptions struct {
	Path      string
	Overwrite bool
}

// ValidationIssue describes one actionable config problem.
type ValidationIssue struct {
	Field   string
	Message string
}

// ValidationError groups all validation problems found in one pass.
type ValidationError struct {
	Issues []ValidationIssue
}

func (e *ValidationError) Error() string {
	if len(e.Issues) == 0 {
		return "invalid config"
	}

	parts := make([]string, 0, len(e.Issues))
	for _, issue := range e.Issues {
		parts = append(parts, fmt.Sprintf("%s: %s", issue.Field, issue.Message))
	}
	return "invalid config: " + strings.Join(parts, "; ")
}

// IsValidation reports whether err contains a ValidationError.
func IsValidation(err error) bool {
	var validationErr *ValidationError
	return errors.As(err, &validationErr)
}

// DefaultPath returns the default runtime.toml path.
func DefaultPath() (string, error) {
	return ResolvePath("")
}

// ResolvePath resolves an explicit config path, LOCAL_RUNTIME_CONFIG, or the
// default XDG/macOS location.
func ResolvePath(path string) (string, error) {
	if path == "" {
		path = os.Getenv(EnvConfigPath)
	}
	if path == "" {
		configHome := os.Getenv("XDG_CONFIG_HOME")
		if configHome == "" {
			home, err := os.UserHomeDir()
			if err != nil {
				return "", fmt.Errorf("resolve config path: user home directory: %w", err)
			}
			configHome = filepath.Join(home, ".config")
		}
		path = filepath.Join(configHome, defaultConfigSubpath)
	}

	resolved, err := expandHome(path)
	if err != nil {
		return "", err
	}
	if !filepath.IsAbs(resolved) {
		resolved, err = filepath.Abs(resolved)
		if err != nil {
			return "", fmt.Errorf("resolve config path %q: %w", path, err)
		}
	}
	return filepath.Clean(resolved), nil
}

// Load reads, decodes, applies environment overrides, and validates runtime.toml.
func Load(path string) (*Config, error) {
	resolved, err := ResolvePath(path)
	if err != nil {
		return nil, err
	}

	data, err := os.ReadFile(resolved)
	if err != nil {
		return nil, fmt.Errorf("read config %s: %w", resolved, err)
	}

	cfg, err := Parse(data)
	if err != nil {
		return nil, err
	}
	cfg.Path = resolved
	return cfg, nil
}

// Parse decodes, applies environment overrides, and validates TOML config data.
func Parse(data []byte) (*Config, error) {
	var cfg Config
	meta, err := toml.Decode(string(data), &cfg)
	if err != nil {
		return nil, fmt.Errorf("parse config TOML: %w", err)
	}
	if undecoded := meta.Undecoded(); len(undecoded) > 0 {
		unknown := make([]string, 0, len(undecoded))
		for _, key := range undecoded {
			unknown = append(unknown, key.String())
		}
		return nil, fmt.Errorf("parse config TOML: unknown field(s): %s", strings.Join(unknown, ", "))
	}

	ApplyEnvOverrides(&cfg)
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return &cfg, nil
}

// ApplyEnvOverrides replaces cloud credentials from process environment.
func ApplyEnvOverrides(cfg *Config) {
	if endpoint := strings.TrimSpace(os.Getenv(EnvCloudEndpoint)); endpoint != "" {
		cfg.Cloud.Endpoint = endpoint
	}
	if token := strings.TrimSpace(os.Getenv(EnvCloudToken)); token != "" {
		cfg.Cloud.Token = token
	}
}

// Validate returns actionable errors for missing or malformed config fields.
func (c Config) Validate() error {
	var issues []ValidationIssue
	requireNonEmpty(&issues, "machine.display_name", c.Machine.DisplayName)
	if strings.TrimSpace(c.Machine.WorkspaceRoot) != "" {
		requireExistingDirectory(&issues, "machine.workspace_root", c.Machine.WorkspaceRoot)
	}
	requireURL(&issues, "cloud.endpoint", c.Cloud.Endpoint, "ws", "wss")
	requireNonEmpty(&issues, "cloud.workspace_id", c.Cloud.WorkspaceID)
	requireNonEmpty(&issues, "cloud.token", c.Cloud.Token)

	runnerCount := 0
	if c.Runners.OpenAICompatible != nil {
		runnerCount++
		requireURL(&issues, "runner.openai_compatible.endpoint", c.Runners.OpenAICompatible.Endpoint, "http", "https")
		requireNonEmpty(&issues, "runner.openai_compatible.model", c.Runners.OpenAICompatible.Model)
	}
	if c.Runners.OpenClaw != nil {
		runnerCount++
		requireURL(&issues, "runner.openclaw.endpoint", c.Runners.OpenClaw.Endpoint, "http", "https")
	}
	if runnerCount == 0 {
		issues = append(issues, ValidationIssue{
			Field:   "runner",
			Message: "configure at least one runner: openai_compatible or openclaw",
		})
	}

	if len(issues) > 0 {
		return &ValidationError{Issues: issues}
	}
	return nil
}

// Write writes a registration runtime.toml file with owner-only file
// permissions. Existing parent directories are never chmodded.
func Write(cfg Config, opts WriteOptions) (string, error) {
	if err := validateForWrite(cfg); err != nil {
		return "", err
	}

	path, err := ResolvePath(opts.Path)
	if err != nil {
		return "", err
	}

	if err := ensureConfigDir(filepath.Dir(path)); err != nil {
		return "", err
	}

	flags := os.O_WRONLY | os.O_CREATE
	if opts.Overwrite {
		flags |= os.O_TRUNC
	} else {
		flags |= os.O_EXCL
	}

	file, err := os.OpenFile(path, flags, 0o600)
	if errors.Is(err, os.ErrExist) {
		return "", fmt.Errorf("%w at %s; pass --force to replace it", ErrConfigExists, path)
	}
	if err != nil {
		return "", fmt.Errorf("open config file: %w", err)
	}
	defer file.Close()

	data, err := renderRegistrationTOML(cfg)
	if err != nil {
		return "", err
	}
	if _, err := file.Write(data); err != nil {
		return "", fmt.Errorf("write config file: %w", err)
	}
	if err := file.Chmod(0o600); err != nil {
		return "", fmt.Errorf("secure config file permissions: %w", err)
	}

	return path, nil
}

func validateForWrite(cfg Config) error {
	if strings.TrimSpace(cfg.Machine.DisplayName) == "" {
		return errors.New("machine display name is required")
	}
	if strings.TrimSpace(cfg.Cloud.Endpoint) == "" {
		return errors.New("cloud endpoint is required")
	}
	if strings.TrimSpace(cfg.Cloud.WorkspaceID) == "" {
		return errors.New("workspace id is required")
	}
	if strings.TrimSpace(cfg.Cloud.Token) == "" {
		return errors.New("one-time token is required")
	}
	if cfg.Runners.OpenAICompatible == nil && cfg.Runners.OpenClaw == nil {
		return errors.New("at least one runner is required")
	}
	if cfg.Runners.OpenAICompatible != nil {
		if strings.TrimSpace(cfg.Runners.OpenAICompatible.Endpoint) == "" {
			return errors.New("openai-compatible runner endpoint is required")
		}
		if strings.TrimSpace(cfg.Runners.OpenAICompatible.Model) == "" {
			return errors.New("openai-compatible runner model is required")
		}
	}
	if cfg.Runners.OpenClaw != nil && strings.TrimSpace(cfg.Runners.OpenClaw.Endpoint) == "" {
		return errors.New("openclaw runner endpoint is required")
	}
	return nil
}

func ensureConfigDir(dir string) error {
	info, err := os.Stat(dir)
	if err == nil {
		if !info.IsDir() {
			return fmt.Errorf("config parent path is not a directory: %s", dir)
		}
		return nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("stat config directory: %w", err)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create config directory: %w", err)
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return fmt.Errorf("secure config directory permissions: %w", err)
	}
	return nil
}

func renderRegistrationTOML(cfg Config) ([]byte, error) {
	var b bytes.Buffer
	if err := writeRegistrationTOML(&b, cfg); err != nil {
		return nil, err
	}
	return b.Bytes(), nil
}

func writeRegistrationTOML(w io.Writer, cfg Config) error {
	if _, err := io.WriteString(w, "# OpenMacaw local runtime helper config.\n"); err != nil {
		return fmt.Errorf("write registration TOML header: %w", err)
	}
	if _, err := io.WriteString(w, "# Written by `local-runtime-helper register`.\n\n"); err != nil {
		return fmt.Errorf("write registration TOML header: %w", err)
	}

	registration := struct {
		Machine MachineConfig `toml:"machine"`
		Cloud   CloudConfig   `toml:"cloud"`
		Runners RunnerConfigs `toml:"runner"`
	}{
		Machine: cfg.Machine,
		Cloud:   cfg.Cloud,
		Runners: cfg.Runners,
	}
	if err := toml.NewEncoder(w).Encode(registration); err != nil {
		return fmt.Errorf("encode registration TOML: %w", err)
	}
	return nil
}

func requireNonEmpty(issues *[]ValidationIssue, field, value string) {
	if strings.TrimSpace(value) == "" {
		*issues = append(*issues, ValidationIssue{
			Field:   field,
			Message: "must not be empty",
		})
	}
}

func requireURL(issues *[]ValidationIssue, field, raw string, schemes ...string) {
	if strings.TrimSpace(raw) == "" {
		*issues = append(*issues, ValidationIssue{
			Field:   field,
			Message: "must not be empty",
		})
		return
	}

	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		*issues = append(*issues, ValidationIssue{
			Field:   field,
			Message: "must be an absolute URL",
		})
		return
	}

	for _, scheme := range schemes {
		if parsed.Scheme == scheme {
			return
		}
	}
	*issues = append(*issues, ValidationIssue{
		Field:   field,
		Message: fmt.Sprintf("must use one of these schemes: %s", strings.Join(schemes, ", ")),
	})
}

func requireExistingDirectory(issues *[]ValidationIssue, field, path string) {
	resolved, err := expandHome(strings.TrimSpace(path))
	if err != nil {
		*issues = append(*issues, ValidationIssue{
			Field:   field,
			Message: err.Error(),
		})
		return
	}
	if !filepath.IsAbs(resolved) {
		*issues = append(*issues, ValidationIssue{
			Field:   field,
			Message: "must be an absolute path",
		})
		return
	}
	info, err := os.Stat(resolved)
	if err != nil {
		*issues = append(*issues, ValidationIssue{
			Field:   field,
			Message: fmt.Sprintf("must exist and be readable: %v", err),
		})
		return
	}
	if !info.IsDir() {
		*issues = append(*issues, ValidationIssue{
			Field:   field,
			Message: "must be a directory",
		})
	}
}

func expandHome(path string) (string, error) {
	if path == "~" || strings.HasPrefix(path, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("resolve config path %q: user home directory: %w", path, err)
		}
		if path == "~" {
			return home, nil
		}
		return filepath.Join(home, strings.TrimPrefix(path, "~/")), nil
	}
	return path, nil
}
