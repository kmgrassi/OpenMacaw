package relay

import (
	"testing"

	"github.com/kmgrassi/local-runtime-helper/internal/config"
	"github.com/kmgrassi/local-runtime-helper/internal/diagnostics"
)

type recordingLogger struct {
	events []diagnostics.EventEnvelope
}

func (l *recordingLogger) Log(event diagnostics.EventEnvelope) error {
	l.events = append(l.events, event)
	return nil
}

func TestDiagnosticsConnectionAttemptLogsHostOnly(t *testing.T) {
	logger := &recordingLogger{}
	d := Diagnostics{Logger: logger}

	if err := d.ConnectionAttempt("wss://relay.example.test/worker-bridge/relay/ws?token=secret"); err != nil {
		t.Fatalf("ConnectionAttempt() error = %v", err)
	}

	if len(logger.events) != 1 {
		t.Fatalf("logged %d events, want 1", len(logger.events))
	}
	if logger.events[0].Type != diagnostics.EventConnectionAttempt {
		t.Fatalf("event type = %q", logger.events[0].Type)
	}
	if got := logger.events[0].EndpointHost; got != "relay.example.test" {
		t.Fatalf("endpoint host = %#v", got)
	}
}

func TestDiagnosticsCancellationIncludesTypedFailure(t *testing.T) {
	logger := &recordingLogger{}
	d := Diagnostics{Logger: logger}

	if err := d.Cancellation("dispatch-123", "openai_compatible"); err != nil {
		t.Fatalf("Cancellation() error = %v", err)
	}

	got := logger.events[0]
	if got.Type != diagnostics.EventCancellation {
		t.Fatalf("event type = %q", got.Type)
	}
	if got.CorrelationID != "dispatch-123" {
		t.Fatalf("correlation id = %q", got.CorrelationID)
	}
	if got.RunnerKind != "openai_compatible" {
		t.Fatalf("runner kind = %q", got.RunnerKind)
	}
	if got.FailureReason != diagnostics.FailureCanceled {
		t.Fatalf("failure reason = %q", got.FailureReason)
	}
}

func TestNewClientFromConfigAdvertisesRuntimeManagedTools(t *testing.T) {
	cfg := &config.Config{
		Machine: config.MachineConfig{ID: "machine-uuid", DisplayName: "dev-machine"},
		Cloud: config.CloudConfig{
			Endpoint:    "ws://127.0.0.1:4000",
			WorkspaceID: "dev-workspace",
			Token:       "token",
		},
		Runners: config.RunnerConfigs{
			OpenAICompatible: &config.OpenAICompatibleConfig{
				Endpoint: "http://localhost:11434/v1",
				Model:    "qwen3-coder:30b",
			},
		},
	}

	clientCfg := NewClientFromConfig(cfg, []string{"openai_compatible"}, "0.2.0-test", nil, nil)
	if clientCfg.Version != "0.2.0-test" {
		t.Fatalf("version = %q, want 0.2.0-test", clientCfg.Version)
	}
	if clientCfg.MachineID != "machine-uuid" {
		t.Fatalf("machine id = %q, want machine-uuid", clientCfg.MachineID)
	}
	if clientCfg.MachineDisplayName != "dev-machine" {
		t.Fatalf("machine display name = %q, want dev-machine", clientCfg.MachineDisplayName)
	}
	if len(clientCfg.Runners) != 1 {
		t.Fatalf("runners = %#v, want one runner registration", clientCfg.Runners)
	}
	runner := clientCfg.Runners[0]
	if runner.RunnerKind != "openai_compatible" {
		t.Fatalf("runner kind = %q, want openai_compatible", runner.RunnerKind)
	}
	if runner.Capabilities["manager_tool_calling"] != nil {
		t.Fatalf("manager_tool_calling capability should not be advertised: %#v", runner.Capabilities)
	}
	if runner.Capabilities["runtime_managed_tools"] != true {
		t.Fatalf("runtime_managed_tools = %#v, want true", runner.Capabilities["runtime_managed_tools"])
	}
	if runner.Capabilities["helper_managed_tools"] != nil {
		t.Fatalf("helper_managed_tools should not be advertised without a workspace root: %#v", runner.Capabilities)
	}
}

func TestNewClientFromConfigAdvertisesHelperManagedToolsWithWorkspaceRoot(t *testing.T) {
	cfg := &config.Config{
		Machine: config.MachineConfig{DisplayName: "dev-machine", WorkspaceRoot: t.TempDir()},
		Cloud: config.CloudConfig{
			Endpoint:    "ws://127.0.0.1:4000",
			WorkspaceID: "dev-workspace",
			Token:       "token",
		},
		Runners: config.RunnerConfigs{
			OpenAICompatible: &config.OpenAICompatibleConfig{
				Endpoint: "http://localhost:11434/v1",
				Model:    "qwen3-coder:30b",
			},
		},
	}

	clientCfg := NewClientFromConfig(cfg, []string{"openai_compatible"}, "0.2.0-test", nil, nil)
	if len(clientCfg.Runners) != 1 {
		t.Fatalf("runners = %#v, want one runner registration", clientCfg.Runners)
	}
	runner := clientCfg.Runners[0]
	if runner.Capabilities["helper_managed_tools"] != true {
		t.Fatalf("helper_managed_tools = %#v, want true", runner.Capabilities["helper_managed_tools"])
	}
}
