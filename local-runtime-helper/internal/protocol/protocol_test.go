package protocol

import (
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"
)

func TestFrameRoundTrip(t *testing.T) {
	t.Parallel()

	percent := 42.5
	now := time.Date(2026, 4, 26, 12, 34, 56, 0, time.UTC)
	status := 503

	tests := []struct {
		name  string
		frame Frame
	}{
		{
			name: "register",
			frame: &RegisterFrame{
				BaseFrame:          BaseFrame{Type: TypeRegister, SchemaVersion: SchemaVersion},
				WorkspaceID:        "workspace_123",
				MachineID:          "machine_123",
				MachineDisplayName: "M2 MacBook Pro",
				Version:            "0.2.0-test",
				RunnerKinds:        []string{"openai_compatible", "openclaw"},
				Runners: []RunnerRegistration{{
					RunnerKind: "openai_compatible",
					Provider:   "openai_compatible",
					Model:      "qwen2.5-coder:latest",
					Capabilities: map[string]any{
						"runtime_managed_tools": true,
						"tool_calls":            true,
					},
				}},
			},
		},
		{
			name: "register_ack",
			frame: &RegisterAckFrame{
				BaseFrame:                  BaseFrame{Type: TypeRegisterAck, SchemaVersion: SchemaVersion},
				MachineID:                  "machine_123",
				HeartbeatIntervalMillis:    30000,
				HeartbeatTimeoutMillis:     60000,
				MaxConcurrentDispatches:    4,
				ReconnectBackoffHintMillis: 1000,
			},
		},
		{
			name: "dispatch",
			frame: &DispatchFrame{
				CorrelatedFrame: CorrelatedFrame{
					BaseFrame:     BaseFrame{Type: TypeDispatch, SchemaVersion: SchemaVersion},
					CorrelationID: "dispatch_123",
				},
				RunnerKind:       "local_relay",
				TargetRunnerKind: "openai_compatible",
				Payload:          json.RawMessage(`{"model":"qwen2.5-coder:latest"}`),
			},
		},
		{
			name: "progress",
			frame: &ProgressFrame{
				CorrelatedFrame: CorrelatedFrame{
					BaseFrame:     BaseFrame{Type: TypeProgress, SchemaVersion: SchemaVersion},
					CorrelationID: "dispatch_123",
				},
				Message: "loading model",
				Percent: &percent,
			},
		},
		{
			name: "output",
			frame: &OutputFrame{
				CorrelatedFrame: CorrelatedFrame{
					BaseFrame:     BaseFrame{Type: TypeOutput, SchemaVersion: SchemaVersion},
					CorrelationID: "dispatch_123",
				},
				Stream:   "stdout",
				Content:  "hello",
				Sequence: 7,
			},
		},
		{
			name: "complete",
			frame: &CompleteFrame{
				CorrelatedFrame: CorrelatedFrame{
					BaseFrame:     BaseFrame{Type: TypeComplete, SchemaVersion: SchemaVersion},
					CorrelationID: "dispatch_123",
				},
				Result: json.RawMessage(`{"finish_reason":"stop"}`),
			},
		},
		{
			name: "error",
			frame: &ErrorFrame{
				CorrelatedFrame: CorrelatedFrame{
					BaseFrame:     BaseFrame{Type: TypeError, SchemaVersion: SchemaVersion},
					CorrelationID: "dispatch_123",
				},
				Code:      "runner_unavailable",
				ErrorCode: "provider_overloaded",
				Message:   "local endpoint refused connection",
				Retryable: true,
				Detail: &ErrorDetail{
					HTTPStatus: &status,
					DialError:  "connect: connection refused",
					Endpoint:   "http://127.0.0.1:11434/v1/chat/completions",
					RawMessage: "dial tcp 127.0.0.1:11434: connect: connection refused",
				},
			},
		},
		{
			name: "heartbeat",
			frame: &HeartbeatFrame{
				BaseFrame: BaseFrame{Type: TypeHeartbeat, SchemaVersion: SchemaVersion},
				SentAt:    now,
				Version:   "0.2.0-test",
				Runners: []RunnerRegistration{{
					RunnerKind: "openai_compatible",
					Provider:   "openai_compatible",
					Model:      "qwen2.5-coder:latest",
					Capabilities: map[string]any{
						"tool_calls": true,
					},
				}},
			},
		},
		{
			name: "cancel",
			frame: &CancelFrame{
				CorrelatedFrame: CorrelatedFrame{
					BaseFrame:     BaseFrame{Type: TypeCancel, SchemaVersion: SchemaVersion},
					CorrelationID: "dispatch_123",
				},
				Reason: "user requested cancellation",
			},
		},
		{
			name: "cancel_ack",
			frame: &CancelAckFrame{
				CorrelatedFrame: CorrelatedFrame{
					BaseFrame:     BaseFrame{Type: TypeCancelAck, SchemaVersion: SchemaVersion},
					CorrelationID: "dispatch_123",
				},
				Outcome: "canceled",
			},
		},
		{
			name: "tool_call_request",
			frame: &ToolCallRequestFrame{
				CorrelatedFrame: CorrelatedFrame{
					BaseFrame:     BaseFrame{Type: TypeToolCallRequest, SchemaVersion: SchemaVersion},
					CorrelationID: "dispatch_123",
				},
				ToolCalls: []ToolCallInfo{{
					ID:        "call_123",
					Name:      "filesystem_read",
					Arguments: map[string]any{"path": "README.md"},
					GrantProvenance: &GrantProvenance{
						AgentToolGrantID:     "grant_123",
						Source:               "template",
						SourceToolTemplateID: "template_coding",
						Reason:               "default coding tool",
						CreatedByUserID:      "user_123",
					},
				}},
			},
		},
		{
			name: "tool_execution_request",
			frame: &ToolExecutionRequestFrame{
				CorrelatedFrame: CorrelatedFrame{
					BaseFrame:     BaseFrame{Type: TypeToolExecRequest, SchemaVersion: SchemaVersion},
					CorrelationID: "dispatch_123",
				},
				ToolCallID:      "call_123",
				Name:            "filesystem_read",
				Arguments:       map[string]any{"path": "README.md"},
				Context:         map[string]any{"workspace_id": "workspace_123", "agent_id": "agent_123"},
				ExecutionKind:   "filesystem_read",
				ExecutionConfig: map[string]any{"max_read_bytes": float64(1024)},
			},
		},
		{
			name: "tool_call_result",
			frame: &ToolCallResultFrame{
				CorrelatedFrame: CorrelatedFrame{
					BaseFrame:     BaseFrame{Type: TypeToolCallResult, SchemaVersion: SchemaVersion},
					CorrelationID: "dispatch_123",
				},
				ToolCallID: "call_123",
				Success:    true,
				Output:     map[string]any{"content": "file contents"},
				DurationMs: 12,
			},
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			data, err := EncodeFrame(tt.frame)
			if err != nil {
				t.Fatalf("EncodeFrame() error = %v", err)
			}

			got, err := DecodeFrame(data)
			if err != nil {
				t.Fatalf("DecodeFrame() error = %v", err)
			}
			if dispatch, ok := tt.frame.(*DispatchFrame); ok {
				dispatch.Raw = data
			}

			if !reflect.DeepEqual(got, tt.frame) {
				t.Fatalf("round trip mismatch:\n got: %#v\nwant: %#v", got, tt.frame)
			}
		})
	}
}

func TestDecodeFrameRejectsUnknownType(t *testing.T) {
	t.Parallel()

	_, err := DecodeFrame([]byte(`{"type":"mystery","schema_version":"1"}`))
	if err == nil {
		t.Fatal("DecodeFrame() error = nil, want UnknownFrameTypeError")
	}

	var unknown *UnknownFrameTypeError
	if !errors.As(err, &unknown) {
		t.Fatalf("DecodeFrame() error = %T, want UnknownFrameTypeError", err)
	}
	if unknown.Type != "mystery" {
		t.Fatalf("unknown.Type = %q, want mystery", unknown.Type)
	}
}

func TestDecodeFramePreservesRawDispatch(t *testing.T) {
	t.Parallel()

	data := []byte(`{"type":"dispatch","schema_version":"1","correlation_id":"dispatch_123","runner_kind":"local_relay","target_runner_kind":"openai_compatible","model":"qwen","messages":[{"role":"user","content":"hi"}]}`)

	frame, err := DecodeFrame(data)
	if err != nil {
		t.Fatalf("DecodeFrame() error = %v", err)
	}
	dispatch, ok := frame.(*DispatchFrame)
	if !ok {
		t.Fatalf("frame = %T, want *DispatchFrame", frame)
	}
	if string(dispatch.Raw) != string(data) {
		t.Fatalf("raw dispatch = %s, want %s", dispatch.Raw, data)
	}
}

func TestDecodeFrameRejectsVersionMismatch(t *testing.T) {
	t.Parallel()

	_, err := DecodeFrame([]byte(`{"type":"heartbeat","schema_version":"2","sent_at":"2026-04-26T12:34:56Z"}`))
	if err == nil {
		t.Fatal("DecodeFrame() error = nil, want VersionMismatchError")
	}

	var mismatch *VersionMismatchError
	if !errors.As(err, &mismatch) {
		t.Fatalf("DecodeFrame() error = %T, want VersionMismatchError", err)
	}
	if mismatch.Got != "2" || mismatch.Want != SchemaVersion {
		t.Fatalf("mismatch = %#v, want got 2 want %s", mismatch, SchemaVersion)
	}
}

func TestEncodeFrameRejectsInvalidVersion(t *testing.T) {
	t.Parallel()

	_, err := EncodeFrame(&HeartbeatFrame{
		BaseFrame: BaseFrame{Type: TypeHeartbeat, SchemaVersion: "2"},
		SentAt:    time.Date(2026, 4, 26, 12, 34, 56, 0, time.UTC),
	})
	if err == nil {
		t.Fatal("EncodeFrame() error = nil, want VersionMismatchError")
	}

	var mismatch *VersionMismatchError
	if !errors.As(err, &mismatch) {
		t.Fatalf("EncodeFrame() error = %T, want VersionMismatchError", err)
	}
}

func TestEncodeFrameRejectsTypedNil(t *testing.T) {
	t.Parallel()

	var frame *HeartbeatFrame
	_, err := EncodeFrame(frame)
	if err == nil {
		t.Fatal("EncodeFrame() error = nil, want NilFrameError")
	}

	var nilFrame *NilFrameError
	if !errors.As(err, &nilFrame) {
		t.Fatalf("EncodeFrame() error = %T, want NilFrameError", err)
	}
}

func TestEncodeFrameRejectsFrameTypeMismatch(t *testing.T) {
	t.Parallel()

	_, err := EncodeFrame(&HeartbeatFrame{
		BaseFrame: BaseFrame{Type: TypeDispatch, SchemaVersion: SchemaVersion},
		SentAt:    time.Date(2026, 4, 26, 12, 34, 56, 0, time.UTC),
	})
	if err == nil {
		t.Fatal("EncodeFrame() error = nil, want FrameTypeMismatchError")
	}

	var mismatch *FrameTypeMismatchError
	if !errors.As(err, &mismatch) {
		t.Fatalf("EncodeFrame() error = %T, want FrameTypeMismatchError", err)
	}
	if mismatch.Got != TypeDispatch || mismatch.Want != TypeHeartbeat {
		t.Fatalf("mismatch = %#v, want got %s want %s", mismatch, TypeDispatch, TypeHeartbeat)
	}
}
