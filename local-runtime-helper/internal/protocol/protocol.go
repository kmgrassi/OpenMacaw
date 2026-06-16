// Package protocol defines the JSON wire frames exchanged between the local
// runtime helper and the cloud relay.
package protocol

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// SchemaVersion identifies the wire-protocol revision. Bump this only for
// incompatible wire changes.
const SchemaVersion = "1"

const (
	TypeRegister    = "register"
	TypeRegisterAck = "register_ack"
	TypeDispatch    = "dispatch"
	TypeProgress    = "progress"
	TypeOutput      = "output"
	TypeComplete    = "complete"
	TypeError       = "error"
	TypeHeartbeat   = "heartbeat"
	TypeCancel      = "cancel"
	TypeCancelAck   = "cancel_ack"

	TypeToolCallRequest = "tool_call_request"
	TypeToolExecRequest = "tool_execution_request"
	TypeToolCallResult  = "tool_call_result"
)

// Frame is implemented by every typed wire frame.
type Frame interface {
	frame()
}

// BaseFrame contains fields common to every frame.
type BaseFrame struct {
	Type          string `json:"type"`
	SchemaVersion string `json:"schema_version"`
}

// CorrelatedFrame contains fields common to dispatch-scoped frames.
type CorrelatedFrame struct {
	BaseFrame
	CorrelationID string `json:"correlation_id"`
}

// RegisterFrame is the first frame sent by the helper after connecting. It
// advertises this machine and the runner kinds available locally.
type RegisterFrame struct {
	BaseFrame
	WorkspaceID        string               `json:"workspace_id"`
	MachineID          string               `json:"machine_id,omitempty"`
	MachineDisplayName string               `json:"machine_display_name"`
	Version            string               `json:"version,omitempty"`
	RunnerKinds        []string             `json:"runner_kinds"`
	Runners            []RunnerRegistration `json:"runners,omitempty"`
}

// RunnerRegistration describes a concrete initialized runner and its
// capabilities for runtime-side scheduling and tool-mode negotiation.
type RunnerRegistration struct {
	RunnerKind   string         `json:"runner_kind"`
	Provider     string         `json:"provider,omitempty"`
	Model        string         `json:"model,omitempty"`
	Capabilities map[string]any `json:"capabilities,omitempty"`
}

// RegisterAckFrame confirms the cloud accepted the helper registration.
type RegisterAckFrame struct {
	BaseFrame
	MachineID                  string `json:"machine_id"`
	HeartbeatIntervalMillis    int    `json:"heartbeat_interval_millis"`
	HeartbeatTimeoutMillis     int    `json:"heartbeat_timeout_millis"`
	MaxConcurrentDispatches    int    `json:"max_concurrent_dispatches,omitempty"`
	ReconnectBackoffHintMillis int    `json:"reconnect_backoff_hint_millis,omitempty"`
}

// DispatchFrame asks the helper to execute work with a specific local runner.
type DispatchFrame struct {
	CorrelatedFrame
	RunnerKind       string          `json:"runner_kind"`
	TargetRunnerKind string          `json:"target_runner_kind,omitempty"`
	Payload          json.RawMessage `json:"payload,omitempty"`
	Raw              json.RawMessage `json:"-"`
}

// ProgressFrame reports incremental dispatch progress.
type ProgressFrame struct {
	CorrelatedFrame
	Message string   `json:"message,omitempty"`
	Event   string   `json:"event,omitempty"`
	Text    string   `json:"text,omitempty"`
	Percent *float64 `json:"percent,omitempty"`
}

// OutputFrame streams output produced by a dispatch.
type OutputFrame struct {
	CorrelatedFrame
	Stream   string `json:"stream,omitempty"`
	Content  string `json:"content"`
	Sequence int64  `json:"sequence,omitempty"`
}

// CompleteFrame marks a dispatch as successfully finished.
type CompleteFrame struct {
	CorrelatedFrame
	Result json.RawMessage `json:"result,omitempty"`
}

// ErrorFrame reports a typed failure. It can be scoped to a dispatch when
// correlation_id is present.
type ErrorFrame struct {
	CorrelatedFrame
	Code      string       `json:"code"`
	ErrorCode string       `json:"error_code,omitempty"`
	Message   string       `json:"message"`
	Retryable bool         `json:"retryable,omitempty"`
	Detail    *ErrorDetail `json:"detail,omitempty"`
}

// ErrorDetail preserves provider/transport-specific failure context alongside
// the normalized retry code.
type ErrorDetail struct {
	HTTPStatus *int   `json:"http_status,omitempty"`
	DialError  string `json:"dial_error,omitempty"`
	Endpoint   string `json:"endpoint,omitempty"`
	RawMessage string `json:"raw_message,omitempty"`
}

// HeartbeatFrame is exchanged periodically to keep the relay connection alive.
type HeartbeatFrame struct {
	BaseFrame
	SentAt  time.Time            `json:"sent_at"`
	Version string               `json:"version,omitempty"`
	Runners []RunnerRegistration `json:"runners,omitempty"`
}

// CancelFrame requests cancellation for an in-flight dispatch.
type CancelFrame struct {
	CorrelatedFrame
	Reason string `json:"reason,omitempty"`
}

// CancelAckFrame confirms the helper observed a cancel frame.
type CancelAckFrame struct {
	CorrelatedFrame
	Outcome string `json:"outcome"`
}

// ToolCallInfo describes one model-requested tool call.
type ToolCallInfo struct {
	ID              string           `json:"id"`
	Name            string           `json:"name"`
	Arguments       map[string]any   `json:"arguments"`
	GrantProvenance *GrantProvenance `json:"grant_provenance,omitempty"`
}

// GrantProvenance is optional, non-secret audit metadata copied from a
// dispatch tool definition when Runtime includes it.
type GrantProvenance struct {
	AgentToolGrantID     string `json:"agent_tool_grant_id,omitempty"`
	Source               string `json:"source,omitempty"`
	SourceToolTemplateID string `json:"source_tool_template_id,omitempty"`
	Reason               string `json:"reason,omitempty"`
	CreatedByUserID      string `json:"created_by_user_id,omitempty"`
}

// ToolCallRequestFrame asks the cloud-managed loop to execute model-requested
// tool calls.
type ToolCallRequestFrame struct {
	CorrelatedFrame
	ToolCalls []ToolCallInfo `json:"tool_calls"`
}

// ToolExecutionRequestFrame asks the helper to execute a single tool call.
type ToolExecutionRequestFrame struct {
	CorrelatedFrame
	ToolCallID      string         `json:"tool_call_id"`
	Name            string         `json:"name"`
	Arguments       map[string]any `json:"arguments"`
	Context         map[string]any `json:"context,omitempty"`
	ExecutionKind   string         `json:"execution_kind"`
	ExecutionConfig map[string]any `json:"execution_config,omitempty"`
	// TimeoutMs bounds local execution to the cloud loop's per-tool wait, so a
	// slow command cancels on the user's machine instead of running on after
	// the orchestrator has already timed out. Zero means no cloud-imposed
	// bound (the executor still applies its own per-command timeout).
	TimeoutMs int64 `json:"timeout_ms,omitempty"`
}

// ToolCallResultFrame returns a tool execution result to the relay.
type ToolCallResultFrame struct {
	CorrelatedFrame
	ToolCallID string `json:"tool_call_id"`
	Success    bool   `json:"success"`
	Output     any    `json:"output"`
	DurationMs int64  `json:"duration_ms"`
}

func (*RegisterFrame) frame()             {}
func (*RegisterAckFrame) frame()          {}
func (*DispatchFrame) frame()             {}
func (*ProgressFrame) frame()             {}
func (*OutputFrame) frame()               {}
func (*CompleteFrame) frame()             {}
func (*ErrorFrame) frame()                {}
func (*HeartbeatFrame) frame()            {}
func (*CancelFrame) frame()               {}
func (*CancelAckFrame) frame()            {}
func (*ToolCallRequestFrame) frame()      {}
func (*ToolExecutionRequestFrame) frame() {}
func (*ToolCallResultFrame) frame()       {}

// UnknownFrameTypeError is returned when a JSON frame has an unrecognized type.
type UnknownFrameTypeError struct {
	Type string
}

func (e *UnknownFrameTypeError) Error() string {
	return fmt.Sprintf("unknown protocol frame type %q", e.Type)
}

// VersionMismatchError is returned when a frame uses a schema version this
// helper does not support.
type VersionMismatchError struct {
	Got  string
	Want string
}

func (e *VersionMismatchError) Error() string {
	return fmt.Sprintf("protocol schema version mismatch: got %q, want %q", e.Got, e.Want)
}

// FrameTypeMismatchError is returned when the encoded type field does not
// match the concrete frame struct.
type FrameTypeMismatchError struct {
	Got  string
	Want string
}

func (e *FrameTypeMismatchError) Error() string {
	return fmt.Sprintf("protocol frame type mismatch: got %q, want %q", e.Got, e.Want)
}

// NilFrameError is returned when a typed nil frame pointer is passed for
// encoding.
type NilFrameError struct {
	Type string
}

func (e *NilFrameError) Error() string {
	if e.Type == "" {
		return "cannot encode nil protocol frame"
	}
	return fmt.Sprintf("cannot encode nil protocol frame %s", e.Type)
}

// DecodeError wraps malformed JSON and structurally invalid frame errors.
type DecodeError struct {
	Message string
	Err     error
}

func (e *DecodeError) Error() string {
	if e.Err == nil {
		return e.Message
	}
	return e.Message + ": " + e.Err.Error()
}

func (e *DecodeError) Unwrap() error {
	return e.Err
}

// EncodeFrame marshals a typed frame after validating its type and schema
// version.
func EncodeFrame(frame Frame) ([]byte, error) {
	if frame == nil {
		return nil, &NilFrameError{}
	}
	if err := validateFrame(frame); err != nil {
		return nil, err
	}
	return json.Marshal(frame)
}

// DecodeFrame unmarshals a JSON frame, validates the schema version, and
// returns the matching typed frame.
func DecodeFrame(data []byte) (Frame, error) {
	var env BaseFrame
	if err := json.Unmarshal(data, &env); err != nil {
		return nil, &DecodeError{Message: "decode protocol frame envelope", Err: err}
	}
	if env.Type == "" {
		return nil, &DecodeError{Message: "protocol frame missing type"}
	}
	if env.SchemaVersion != SchemaVersion {
		return nil, &VersionMismatchError{Got: env.SchemaVersion, Want: SchemaVersion}
	}

	frame, err := frameForType(env.Type)
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(data, frame); err != nil {
		return nil, &DecodeError{Message: "decode typed protocol frame", Err: err}
	}
	if dispatch, ok := frame.(*DispatchFrame); ok {
		dispatch.Raw = append(dispatch.Raw[:0], data...)
	}
	return frame, nil
}

func validateFrame(frame Frame) error {
	base, wantType, err := frameMetadata(frame)
	if err != nil {
		return err
	}
	if base.Type == "" {
		return errors.New("protocol frame missing type")
	}
	if base.Type != wantType {
		return &FrameTypeMismatchError{Got: base.Type, Want: wantType}
	}
	if base.SchemaVersion != SchemaVersion {
		return &VersionMismatchError{Got: base.SchemaVersion, Want: SchemaVersion}
	}
	return nil
}

func frameForType(frameType string) (Frame, error) {
	switch frameType {
	case TypeRegister:
		return &RegisterFrame{}, nil
	case TypeRegisterAck:
		return &RegisterAckFrame{}, nil
	case TypeDispatch:
		return &DispatchFrame{}, nil
	case TypeProgress:
		return &ProgressFrame{}, nil
	case TypeOutput:
		return &OutputFrame{}, nil
	case TypeComplete:
		return &CompleteFrame{}, nil
	case TypeError:
		return &ErrorFrame{}, nil
	case TypeHeartbeat:
		return &HeartbeatFrame{}, nil
	case TypeCancel:
		return &CancelFrame{}, nil
	case TypeCancelAck:
		return &CancelAckFrame{}, nil
	case TypeToolCallRequest:
		return &ToolCallRequestFrame{}, nil
	case TypeToolExecRequest:
		return &ToolExecutionRequestFrame{}, nil
	case TypeToolCallResult:
		return &ToolCallResultFrame{}, nil
	default:
		return nil, &UnknownFrameTypeError{Type: frameType}
	}
}

func frameMetadata(frame Frame) (*BaseFrame, string, error) {
	switch f := frame.(type) {
	case *RegisterFrame:
		if f == nil {
			return nil, TypeRegister, &NilFrameError{Type: "*RegisterFrame"}
		}
		return &f.BaseFrame, TypeRegister, nil
	case *RegisterAckFrame:
		if f == nil {
			return nil, TypeRegisterAck, &NilFrameError{Type: "*RegisterAckFrame"}
		}
		return &f.BaseFrame, TypeRegisterAck, nil
	case *DispatchFrame:
		if f == nil {
			return nil, TypeDispatch, &NilFrameError{Type: "*DispatchFrame"}
		}
		return &f.BaseFrame, TypeDispatch, nil
	case *ProgressFrame:
		if f == nil {
			return nil, TypeProgress, &NilFrameError{Type: "*ProgressFrame"}
		}
		return &f.BaseFrame, TypeProgress, nil
	case *OutputFrame:
		if f == nil {
			return nil, TypeOutput, &NilFrameError{Type: "*OutputFrame"}
		}
		return &f.BaseFrame, TypeOutput, nil
	case *CompleteFrame:
		if f == nil {
			return nil, TypeComplete, &NilFrameError{Type: "*CompleteFrame"}
		}
		return &f.BaseFrame, TypeComplete, nil
	case *ErrorFrame:
		if f == nil {
			return nil, TypeError, &NilFrameError{Type: "*ErrorFrame"}
		}
		return &f.BaseFrame, TypeError, nil
	case *HeartbeatFrame:
		if f == nil {
			return nil, TypeHeartbeat, &NilFrameError{Type: "*HeartbeatFrame"}
		}
		return &f.BaseFrame, TypeHeartbeat, nil
	case *CancelFrame:
		if f == nil {
			return nil, TypeCancel, &NilFrameError{Type: "*CancelFrame"}
		}
		return &f.BaseFrame, TypeCancel, nil
	case *CancelAckFrame:
		if f == nil {
			return nil, TypeCancelAck, &NilFrameError{Type: "*CancelAckFrame"}
		}
		return &f.BaseFrame, TypeCancelAck, nil
	case *ToolCallRequestFrame:
		if f == nil {
			return nil, TypeToolCallRequest, &NilFrameError{Type: "*ToolCallRequestFrame"}
		}
		return &f.BaseFrame, TypeToolCallRequest, nil
	case *ToolExecutionRequestFrame:
		if f == nil {
			return nil, TypeToolExecRequest, &NilFrameError{Type: "*ToolExecutionRequestFrame"}
		}
		return &f.BaseFrame, TypeToolExecRequest, nil
	case *ToolCallResultFrame:
		if f == nil {
			return nil, TypeToolCallResult, &NilFrameError{Type: "*ToolCallResultFrame"}
		}
		return &f.BaseFrame, TypeToolCallResult, nil
	default:
		return nil, "", &UnknownFrameTypeError{Type: ""}
	}
}
