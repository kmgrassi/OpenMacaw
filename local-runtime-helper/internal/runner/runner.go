// Package runner defines the adapter interface every local tool
// implementation conforms to (OpenAI-compatible endpoints,
// OpenClaw, DaVinci, Figma, browser automation, etc.).
//
// The relay package picks a Runner by `runner_kind` on each inbound
// dispatch frame and forwards the payload.
//
// Concrete adapters live in sibling packages and register by runner kind.
package runner

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/kmgrassi/local-runtime-helper/internal/diagnostics"
)

const (
	// KindOpenClaw is the wire runner_kind for local OpenClaw execution.
	KindOpenClaw = "openclaw"
)

var (
	// ErrUnknownKind is returned when a dispatch references a runner kind that
	// was not registered on this helper.
	ErrUnknownKind = errors.New("unknown runner kind")
)

// DispatchRequest is the helper-internal representation of one inbound unit of
// work from the relay.
type DispatchRequest struct {
	ID      string `json:"id,omitempty"`
	Kind    string `json:"runner_kind"`
	Payload any    `json:"payload,omitempty"`
}

// EventKind identifies the event emitted while a dispatch runs.
type EventKind string

const (
	EventProgress EventKind = "progress"
	EventOutput   EventKind = "output"
	EventComplete EventKind = "complete"
)

// Event is the common event shape produced by generic runner adapters. Relay
// wiring can translate these into protocol frames once dispatch wiring lands.
type Event struct {
	Kind    EventKind `json:"kind"`
	Message string    `json:"message,omitempty"`
	Output  string    `json:"output,omitempty"`
	Payload any       `json:"payload,omitempty"`
}

// Runner is the adapter interface every local tool implements.
//
// Implementations live in sibling subpackages (e.g.
// internal/runner/openai_compatible) and are wired into the relay
// at startup based on the runner kinds declared in runtime.toml.
type Runner interface {
	// Kind returns the wire-protocol identifier for this runner
	// (e.g. "openai_compatible", "openclaw", "davinci"). Must match
	// the cloud's worker-adapter enum so routing rules resolve.
	Kind() string

	// Dispatch executes one work request. Implementations stream
	// progress + output back through the supplied emit callback,
	// and must respect ctx cancellation (cloud may send a `cancel`
	// frame at any time).
	//
	// A later relay/protocol integration can replace `any` with concrete types
	// derived from the protocol package once those land.
	Dispatch(ctx context.Context, input any, emit func(event any) error) error
}

// Registry routes dispatches by runner kind.
type Registry struct {
	runners map[string]Runner
}

// NewRegistry creates a registry from the supplied runners.
func NewRegistry(runners ...Runner) (*Registry, error) {
	registry := &Registry{runners: make(map[string]Runner, len(runners))}
	for _, r := range runners {
		if r == nil {
			return nil, errors.New("runner registry contains nil runner")
		}

		kind := r.Kind()
		if kind == "" {
			return nil, errors.New("runner registry contains runner with empty kind")
		}
		if _, exists := registry.runners[kind]; exists {
			return nil, fmt.Errorf("runner registry contains duplicate kind %q", kind)
		}
		registry.runners[kind] = r
	}
	return registry, nil
}

// Dispatch selects a registered runner by request kind and forwards the request.
func (r *Registry) Dispatch(ctx context.Context, req DispatchRequest, emit func(any) error) error {
	if r == nil {
		return errors.New("runner registry is nil")
	}

	selected, ok := r.runners[req.Kind]
	if !ok {
		return fmt.Errorf("%w: %s", ErrUnknownKind, req.Kind)
	}
	if emit == nil {
		emit = func(any) error { return nil }
	}
	return selected.Dispatch(ctx, req.Payload, emit)
}

// ChatCompletionInput is the helper's local chat-completion request shape.
//
// The relay will populate this from dispatch payloads once protocol dispatch
// frames are wired in. Runner adapters may ignore fields that their provider
// does not support.
type ChatCompletionInput struct {
	Model             string             `json:"model,omitempty"`
	Messages          []ChatMessage      `json:"messages"`
	Temperature       *float64           `json:"temperature,omitempty"`
	MaxTokens         *int               `json:"max_tokens,omitempty"`
	Stream            *bool              `json:"stream,omitempty"`
	ProviderToolSpecs []ToolSpec         `json:"provider_tool_specs,omitempty"`
	ToolDefinitions   []ToolDefinition   `json:"tool_definitions,omitempty"`
	ToolCallingMode   string             `json:"tool_calling_mode,omitempty"`
	ToolCallingConfig *ToolCallingConfig `json:"tool_calling_config,omitempty"`
	Metadata          map[string]any     `json:"metadata,omitempty"`
}

// ChatMessage mirrors the OpenAI-compatible chat message shape.
type ChatMessage struct {
	Role       string             `json:"role"`
	Content    string             `json:"content"`
	ToolCalls  []ProviderToolCall `json:"tool_calls,omitempty"`
	ToolCallID string             `json:"tool_call_id,omitempty"`
	Metadata   map[string]any     `json:"metadata,omitempty"`
}

// ToolSpec mirrors the OpenAI-compatible tool specification shape sent to
// local model providers.
type ToolSpec struct {
	Type     string       `json:"type"`
	Function ToolFunction `json:"function"`
}

// ToolFunction describes one callable function tool.
type ToolFunction struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Parameters  map[string]any `json:"parameters"`
}

// ToolDefinition is the runtime-dispatched, provider-neutral definition of a
// tool the helper may execute or forward for the current turn.
type ToolDefinition struct {
	Name             string           `json:"name"`
	Description      string           `json:"description"`
	ParametersSchema map[string]any   `json:"parameters_schema"`
	ExecutionKind    string           `json:"execution_kind"`
	ExecutionConfig  map[string]any   `json:"execution_config,omitempty"`
	GrantProvenance  *GrantProvenance `json:"grant_provenance,omitempty"`
	Metadata         map[string]any   `json:"metadata,omitempty"`
}

// GrantProvenance is optional, non-secret audit metadata supplied by
// Platform/Runtime after effective grant resolution. The helper must not use it
// to authorize tool execution.
type GrantProvenance struct {
	AgentToolGrantID     string `json:"agent_tool_grant_id,omitempty"`
	Source               string `json:"source,omitempty"`
	SourceToolTemplateID string `json:"source_tool_template_id,omitempty"`
	Reason               string `json:"reason,omitempty"`
	CreatedByUserID      string `json:"created_by_user_id,omitempty"`
}

// ToolCallingConfig controls helper-managed tool loop limits.
type ToolCallingConfig struct {
	MaxIterations    int `json:"max_iterations,omitempty"`
	TimeoutPerToolMs int `json:"timeout_per_tool_ms,omitempty"`
	TotalTimeoutMs   int `json:"total_timeout_ms,omitempty"`
}

// ProviderToolCall is the OpenAI-compatible tool call shape used only when
// exchanging messages with local model providers.
type ProviderToolCall struct {
	ID       string       `json:"id"`
	Type     string       `json:"type"`
	Function ToolCallFunc `json:"function"`
}

// ToolCallFunc contains the function name and raw JSON argument string.
type ToolCallFunc struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

// ToolCall is the canonical helper-runtime tool call shape.
type ToolCall struct {
	ID              string           `json:"id"`
	Name            string           `json:"name"`
	Arguments       map[string]any   `json:"arguments"`
	GrantProvenance *GrantProvenance `json:"grant_provenance,omitempty"`
}

// ToolExecutionContext is runtime-authored provenance and scope supplied
// out-of-band with model-authored tool arguments.
type ToolExecutionContext map[string]any

// ToolCallRequestEvent asks the cloud-managed loop to execute tool calls.
type ToolCallRequestEvent struct {
	Kind      string     `json:"kind"`
	ToolCalls []ToolCall `json:"tool_calls"`
}

// ToolExecutionEvent reports helper-managed tool execution progress.
type ToolExecutionEvent struct {
	Kind            string           `json:"kind"`
	ToolCallID      string           `json:"tool_call_id"`
	Name            string           `json:"name"`
	Arguments       map[string]any   `json:"arguments,omitempty"`
	GrantProvenance *GrantProvenance `json:"grant_provenance,omitempty"`
	Result          *ToolCallResult  `json:"result,omitempty"`
}

// ToolCallRequest is passed to a local tool executor.
type ToolCallRequest struct {
	ToolCallID string               `json:"tool_call_id"`
	Name       string               `json:"name"`
	Arguments  map[string]any       `json:"arguments"`
	Context    ToolExecutionContext `json:"context,omitempty"`
	Definition *ToolDefinition      `json:"definition,omitempty"`
}

// ToolCallResult is the result of executing a local tool.
type ToolCallResult struct {
	ToolCallID string `json:"tool_call_id"`
	Success    bool   `json:"success"`
	Output     any    `json:"output"`
	DurationMs int64  `json:"duration_ms"`
}

// OutputEvent is emitted for streamed or completed model text.
type OutputEvent struct {
	Kind  string `json:"kind"`
	Text  string `json:"text"`
	Index int    `json:"index,omitempty"`
}

// CompleteEvent is emitted when a model request completes successfully.
type CompleteEvent struct {
	Kind         string `json:"kind"`
	FinishReason string `json:"finish_reason,omitempty"`
}

// ErrorKind identifies normalized runner failure classes.
type ErrorKind string

const (
	ErrorKindInvalidInput        ErrorKind = "invalid_input"
	ErrorKindProvider            ErrorKind = "provider_error"
	ErrorKindModelNotFound       ErrorKind = "model_not_found"
	ErrorKindEndpointUnavailable ErrorKind = "endpoint_unavailable"
	ErrorKindCanceled            ErrorKind = "canceled"
	ErrorKindEmitFailed          ErrorKind = "emit_failed"
)

// Error is a normalized runner error suitable for turning into a protocol
// error frame.
type Error struct {
	Kind       ErrorKind
	Message    string
	StatusCode int
	Code       string
	Hint       string
	Detail     ErrorDetail
}

func (e *Error) Error() string {
	if e == nil {
		return ""
	}
	return e.Message
}

// ErrorDetail preserves underlying provider/transport failure context for
// relay diagnostics without changing normalized retry/error codes.
type ErrorDetail struct {
	HTTPStatus *int
	DialError  string
	Endpoint   string
	RawMessage string
}

// ModelInfo describes one locally advertised model for heartbeat refreshes.
type ModelInfo struct {
	ID           string
	Provider     string
	Capabilities map[string]any
}

// ModelLister is implemented by runners that can refresh their live model list.
type ModelLister interface {
	ListModels(context.Context) ([]ModelInfo, error)
}

// Metadata describes the local target a runner will call.
type Metadata struct {
	Model    string
	Endpoint string
}

// Instrumented wraps a Runner with diagnostic lifecycle logging.
func Instrumented(inner Runner, logger diagnostics.Logger, metadata Metadata) Runner {
	return instrumentedRunner{
		inner:    inner,
		logger:   logger,
		metadata: metadata,
	}
}

type instrumentedRunner struct {
	inner    Runner
	logger   diagnostics.Logger
	metadata Metadata
}

func (r instrumentedRunner) Kind() string {
	return r.inner.Kind()
}

func (r instrumentedRunner) Dispatch(ctx context.Context, input any, emit func(event any) error) error {
	correlationID := correlationIDFrom(input)
	started := time.Now()

	r.log(diagnostics.NewEvent(diagnostics.EventDispatchStarted).
		WithCorrelation(correlationID).
		WithRunner(r.Kind(), r.metadata.Model, r.metadata.Endpoint))

	err := r.inner.Dispatch(ctx, input, emit)
	duration := time.Since(started)
	base := diagnostics.NewEvent(diagnostics.EventDispatchCompleted).
		WithCorrelation(correlationID).
		WithRunner(r.Kind(), r.metadata.Model, r.metadata.Endpoint).
		WithDuration(duration)

	switch {
	case err == nil:
		r.log(base)
	case errors.Is(err, context.Canceled), errors.Is(ctx.Err(), context.Canceled):
		r.log(diagnostics.NewEvent(diagnostics.EventDispatchCanceled).
			WithCorrelation(correlationID).
			WithRunner(r.Kind(), r.metadata.Model, r.metadata.Endpoint).
			WithDuration(duration).
			WithFailure(diagnostics.FailureCanceled, err.Error()))
	default:
		r.log(diagnostics.NewEvent(diagnostics.EventToolError).
			WithCorrelation(correlationID).
			WithRunner(r.Kind(), r.metadata.Model, r.metadata.Endpoint).
			WithDuration(duration).
			WithFailure(diagnostics.FailureToolError, err.Error()))
	}

	return err
}

// LogModelCallStarted emits a model call start event for concrete model runners.
func LogModelCallStarted(logger diagnostics.Logger, correlationID, runnerKind string, metadata Metadata) {
	log(logger, diagnostics.NewEvent(diagnostics.EventModelCallStarted).
		WithCorrelation(correlationID).
		WithRunner(runnerKind, metadata.Model, metadata.Endpoint))
}

// LogModelCallEnded emits a successful model call completion event.
func LogModelCallEnded(logger diagnostics.Logger, correlationID, runnerKind string, metadata Metadata, duration time.Duration) {
	log(logger, diagnostics.NewEvent(diagnostics.EventModelCallEnded).
		WithCorrelation(correlationID).
		WithRunner(runnerKind, metadata.Model, metadata.Endpoint).
		WithDuration(duration))
}

// LogModelError emits a failed model call event with a typed failure reason.
func LogModelError(logger diagnostics.Logger, correlationID, runnerKind string, metadata Metadata, duration time.Duration, err error) {
	message := ""
	if err != nil {
		message = err.Error()
	}
	log(logger, diagnostics.NewEvent(diagnostics.EventModelError).
		WithCorrelation(correlationID).
		WithRunner(runnerKind, metadata.Model, metadata.Endpoint).
		WithDuration(duration).
		WithFailure(diagnostics.FailureModelError, message))
}

func (r instrumentedRunner) log(event diagnostics.EventEnvelope) {
	log(r.logger, event)
}

func log(logger diagnostics.Logger, event diagnostics.EventEnvelope) {
	if logger != nil {
		_ = logger.Log(event)
	}
}

// CorrelationCarrier can be implemented by protocol dispatch inputs.
type CorrelationCarrier interface {
	CorrelationID() string
}

func correlationIDFrom(input any) string {
	carrier, ok := input.(CorrelationCarrier)
	if !ok {
		return ""
	}
	return carrier.CorrelationID()
}
