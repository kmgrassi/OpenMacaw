// Package relay implements the persistent WSS connection from the
// daemon to the cloud orchestrator's worker-bridge.
//
// Wire protocol is documented in
// parallel-agent-runtime/apps/orchestrator/docs/local-relay-protocol.md
// (added in OQ-02 PR 2).
//
// PR 6 (OQ-02) will implement:
//   - WSS dial to <cloud>/worker-bridge/relay/ws using nhooyr.io/websocket
//   - bearer-token auth on connect (Authorization header preferred,
//     query param fallback)
//   - first frame: register (advertises runner kinds)
//   - heartbeat (30s server pings; 2 missed → reconnect)
//   - reconnect with exponential backoff (1s → 60s, jittered)
//   - dispatch routing: incoming dispatch frames → runner package
//   - backpressure: pause emit when send buffer exceeds N pending frames
package relay

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/kmgrassi/local-runtime-helper/internal/diagnostics"
	"github.com/kmgrassi/local-runtime-helper/internal/protocol"
	"github.com/kmgrassi/local-runtime-helper/internal/runner"
)

const (
	DefaultMaxConcurrentDispatches = 4
	DefaultTerminalSendTimeout     = 5 * time.Second
)

// Sender writes outbound frames to the cloud relay transport.
type Sender interface {
	SendFrame(context.Context, protocol.Frame) error
}

// SenderFunc adapts a function to Sender.
type SenderFunc func(context.Context, protocol.Frame) error

func (fn SenderFunc) SendFrame(ctx context.Context, frame protocol.Frame) error {
	return fn(ctx, frame)
}

// ToolExecutor runs a single tool call locally on the user's machine. It is the
// same contract the openai_compatible runner uses for helper-managed loops; a
// nil executor means this helper was started without a workspace root and
// cannot service cloud-delegated tool execution requests.
type ToolExecutor interface {
	Execute(context.Context, runner.ToolCallRequest) runner.ToolCallResult
}

// Dispatcher routes dispatch frames to configured runners and owns per-dispatch
// cancellation, correlation IDs, structured lifecycle logs, and concurrency.
type Dispatcher struct {
	runners      *runner.Registry
	sender       Sender
	logger       *slog.Logger
	toolExecutor ToolExecutor

	sem                 chan struct{}
	terminalSendTimeout time.Duration

	mu       sync.Mutex
	inflight map[string]context.CancelFunc
	wg       sync.WaitGroup
}

// DispatcherOptions configures dispatch routing.
type DispatcherOptions struct {
	Runners             *runner.Registry
	Sender              Sender
	Logger              *slog.Logger
	MaxConcurrent       int
	TerminalSendTimeout time.Duration
	// ToolExecutor services cloud-delegated tool_execution_request frames
	// (e.g. git.run for a local model). Optional; nil when no workspace root
	// is configured.
	ToolExecutor ToolExecutor
}

// NewDispatcher creates a runner dispatcher.
func NewDispatcher(opts DispatcherOptions) (*Dispatcher, error) {
	if opts.Runners == nil {
		return nil, errors.New("runner registry is required")
	}
	if opts.Sender == nil {
		return nil, errors.New("sender is required")
	}
	if opts.Logger == nil {
		opts.Logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	if opts.MaxConcurrent <= 0 {
		opts.MaxConcurrent = DefaultMaxConcurrentDispatches
	}
	if opts.TerminalSendTimeout <= 0 {
		opts.TerminalSendTimeout = DefaultTerminalSendTimeout
	}

	return &Dispatcher{
		runners:             opts.Runners,
		sender:              opts.Sender,
		logger:              opts.Logger,
		toolExecutor:        opts.ToolExecutor,
		sem:                 make(chan struct{}, opts.MaxConcurrent),
		terminalSendTimeout: opts.TerminalSendTimeout,
		inflight:            make(map[string]context.CancelFunc),
	}, nil
}

// StartDispatch accepts a dispatch and starts it asynchronously. It returns
// after the dispatch is accepted or an immediate protocol error is emitted.
func (d *Dispatcher) StartDispatch(ctx context.Context, frame *protocol.DispatchFrame) error {
	if frame == nil {
		return errors.New("dispatch frame is nil")
	}
	if frame.CorrelationID == "" {
		return d.sendError(ctx, frame.CorrelationID, "missing_correlation_id", "dispatch correlation_id is required")
	}

	select {
	case d.sem <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	default:
		return d.sendError(ctx, frame.CorrelationID, "concurrency_limit_exceeded", "maximum concurrent dispatches are already running")
	}

	dispatchCtx, cancel := context.WithCancel(ctx)
	if err := d.track(frame.CorrelationID, cancel); err != nil {
		cancel()
		<-d.sem
		return d.sendError(ctx, frame.CorrelationID, "duplicate_correlation_id", err.Error())
	}

	d.wg.Add(1)
	go d.runDispatch(dispatchCtx, frame, cancel)
	return nil
}

// Cancel cancels an in-flight dispatch and reports whether one was found.
func (d *Dispatcher) Cancel(correlationID string) bool {
	d.mu.Lock()
	cancel := d.inflight[correlationID]
	d.mu.Unlock()
	if cancel != nil {
		cancel()
		return true
	}
	return false
}

// HandleFrame routes cloud frames relevant to dispatch execution.
func (d *Dispatcher) HandleFrame(ctx context.Context, frame protocol.Frame) error {
	switch f := frame.(type) {
	case *protocol.DispatchFrame:
		return d.StartDispatch(ctx, f)
	case *protocol.CancelFrame:
		outcome := "not_found"
		if d.Cancel(f.CorrelationID) {
			outcome = "canceled"
		}
		return d.sender.SendFrame(ctx, &protocol.CancelAckFrame{
			CorrelatedFrame: correlated(protocol.TypeCancelAck, f.CorrelationID),
			Outcome:         outcome,
		})
	case *protocol.ToolExecutionRequestFrame:
		d.startToolExecution(ctx, f)
		return nil
	default:
		return nil
	}
}

// startToolExecution runs a cloud-delegated tool call (e.g. git.run for a local
// model) on this machine and replies with a tool_call_result frame. It runs in
// its own goroutine so a slow command (a network `gh` call) never blocks the
// read loop from processing heartbeats, cancels, or further frames.
func (d *Dispatcher) startToolExecution(ctx context.Context, f *protocol.ToolExecutionRequestFrame) {
	d.wg.Add(1)
	go func() {
		defer d.wg.Done()

		result := protocol.ToolCallResultFrame{
			CorrelatedFrame: correlated(protocol.TypeToolCallResult, f.CorrelationID),
			ToolCallID:      f.ToolCallID,
		}

		if d.toolExecutor == nil {
			d.logger.Warn("tool execution requested but no local tool executor configured",
				"correlation_id", f.CorrelationID, "tool_call_id", f.ToolCallID, "name", f.Name)
			result.Output = map[string]any{
				"ok":     false,
				"error":  "no_local_tool_executor",
				"reason": "helper started without a workspace root; re-register with --workspace-root",
				"name":   f.Name,
			}
		} else {
			// Bound execution to the cloud loop's per-tool wait so the local
			// command is canceled when the orchestrator gives up, instead of
			// continuing to mutate the repo / call GitHub past that point.
			execCtx := ctx
			if f.TimeoutMs > 0 {
				var cancelExec context.CancelFunc
				execCtx, cancelExec = context.WithTimeout(ctx, time.Duration(f.TimeoutMs)*time.Millisecond)
				defer cancelExec()
			}
			res := d.toolExecutor.Execute(execCtx, runner.ToolCallRequest{
				ToolCallID: f.ToolCallID,
				Name:       f.Name,
				Arguments:  f.Arguments,
				Context:    runner.ToolExecutionContext(f.Context),
			})
			result.Success = res.Success
			result.Output = res.Output
			result.DurationMs = res.DurationMs
		}

		// Detach from the read-loop context so the result still sends if the
		// command finished just as the connection is tearing down.
		sendCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), d.terminalSendTimeout)
		defer cancel()
		if err := d.sender.SendFrame(sendCtx, &result); err != nil {
			d.logger.Error("failed to send tool_call_result",
				"error", err, "correlation_id", f.CorrelationID, "tool_call_id", f.ToolCallID)
		}
	}()
}

// Wait blocks until all accepted dispatches finish.
func (d *Dispatcher) Wait() {
	d.wg.Wait()
}

func (d *Dispatcher) runDispatch(ctx context.Context, frame *protocol.DispatchFrame, cancel context.CancelFunc) {
	defer d.wg.Done()
	defer func() {
		cancel()
		d.untrack(frame.CorrelationID)
		<-d.sem
	}()

	runnerKind := dispatchRunnerKind(frame)
	log := d.logger.With(
		"correlation_id", frame.CorrelationID,
		"runner_kind", runnerKind,
	)
	log.Info("dispatch started")

	var output strings.Builder
	var result json.RawMessage
	emit := func(event any) error {
		switch e := event.(type) {
		case runner.Event:
			return d.emitRunnerEvent(ctx, frame.CorrelationID, e, &result)
		case runner.OutputEvent:
			output.WriteString(e.Text)
			return d.sender.SendFrame(ctx, &protocol.ProgressFrame{
				CorrelatedFrame: correlated(protocol.TypeProgress, frame.CorrelationID),
				Message:         "message.delta",
				Event:           "message.delta",
				Text:            e.Text,
			})
		case runner.ToolCallRequestEvent:
			log.Info(
				"runtime tool call request emitted",
				"tool_call_count", len(e.ToolCalls),
				"tool_names", toolCallNames(e.ToolCalls),
				"tool_call_ids", toolCallIDs(e.ToolCalls),
			)
			return d.sender.SendFrame(ctx, &protocol.ToolCallRequestFrame{
				CorrelatedFrame: correlated(protocol.TypeToolCallRequest, frame.CorrelationID),
				ToolCalls:       protocolToolCalls(e.ToolCalls),
			})
		case runner.ToolExecutionEvent:
			log.Debug(
				"helper tool execution event",
				"event", e.Kind,
				"tool_name", e.Name,
				"tool_call_id", e.ToolCallID,
				"arguments", summarizeLogValue(e.Arguments, 500),
				"result", summarizeToolCallResult(e.Result, 500),
			)
			return d.sender.SendFrame(ctx, &protocol.ProgressFrame{
				CorrelatedFrame: correlated(protocol.TypeProgress, frame.CorrelationID),
				Message:         e.Kind,
				Event:           e.Kind,
			})
		case runner.CompleteEvent:
			result = marshalResult(map[string]any{
				"output_text":   output.String(),
				"output":        output.String(),
				"finish_reason": e.FinishReason,
			})
			return nil
		default:
			return fmt.Errorf("unknown runner event type %T", event)
		}
	}

	err := d.runners.Dispatch(ctx, runner.DispatchRequest{
		ID:      frame.CorrelationID,
		Kind:    runnerKind,
		Payload: dispatchPayload(frame),
	}, emit)
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(ctx.Err(), context.Canceled) {
			log.Info("dispatch canceled")
			_ = d.sendTerminalError(ctx, frame.CorrelationID, "canceled", "dispatch was canceled")
			return
		}
		if errors.Is(err, runner.ErrUnknownKind) {
			log.Warn("dispatch referenced unknown runner kind")
			_ = d.sendTerminalError(ctx, frame.CorrelationID, "unknown_runner_kind", fmt.Sprintf("runner kind %q is not configured", runnerKind))
			return
		}

		code := "runner_error"
		var runnerErr *runner.Error
		if errors.As(err, &runnerErr) {
			code = string(runnerErr.Kind)
			errorCode := providerErrorCode(runnerErr)
			log.Error("dispatch failed", "error", err)
			_ = d.sendTerminalErrorWithDetail(ctx, frame.CorrelationID, code, errorCode, err.Error(), providerErrorRetryable(errorCode), protocolErrorDetail(runnerErr.Detail))
			return
		}
		log.Error("dispatch failed", "error", err)
		_ = d.sendTerminalError(ctx, frame.CorrelationID, code, err.Error())
		return
	}

	log.Info("dispatch completed")
	_ = d.sendTerminalFrame(ctx, &protocol.CompleteFrame{
		CorrelatedFrame: correlated(protocol.TypeComplete, frame.CorrelationID),
		Result:          result,
	})
}

func dispatchRunnerKind(frame *protocol.DispatchFrame) string {
	if frame != nil && frame.TargetRunnerKind != "" {
		return frame.TargetRunnerKind
	}
	if frame == nil {
		return ""
	}
	return frame.RunnerKind
}

func dispatchPayload(frame *protocol.DispatchFrame) any {
	if frame == nil {
		return nil
	}
	if len(frame.Payload) > 0 {
		return frame.Payload
	}
	if len(frame.Raw) > 0 {
		return frame.Raw
	}
	return frame
}

func (d *Dispatcher) emitRunnerEvent(ctx context.Context, correlationID string, event runner.Event, result *json.RawMessage) error {
	switch event.Kind {
	case runner.EventProgress:
		return d.sender.SendFrame(ctx, &protocol.ProgressFrame{
			CorrelatedFrame: correlated(protocol.TypeProgress, correlationID),
			Message:         event.Message,
		})
	case runner.EventOutput:
		return d.sender.SendFrame(ctx, &protocol.OutputFrame{
			CorrelatedFrame: correlated(protocol.TypeOutput, correlationID),
			Stream:          "stdout",
			Content:         outputContent(event),
		})
	case runner.EventComplete:
		*result = marshalResult(event.Payload)
		return nil
	default:
		return fmt.Errorf("unknown runner event kind %q", event.Kind)
	}
}

func (d *Dispatcher) track(correlationID string, cancel context.CancelFunc) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, exists := d.inflight[correlationID]; exists {
		return fmt.Errorf("dispatch with correlation_id %q is already running", correlationID)
	}
	d.inflight[correlationID] = cancel
	return nil
}

func (d *Dispatcher) untrack(correlationID string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	delete(d.inflight, correlationID)
}

func (d *Dispatcher) sendError(ctx context.Context, correlationID, code, message string) error {
	return d.sender.SendFrame(ctx, &protocol.ErrorFrame{
		CorrelatedFrame: correlated(protocol.TypeError, correlationID),
		Code:            code,
		Message:         message,
	})
}

func (d *Dispatcher) sendTerminalError(ctx context.Context, correlationID, code, message string) error {
	return d.sendTerminalErrorWithDetail(ctx, correlationID, code, "", message, false, nil)
}

func (d *Dispatcher) sendTerminalErrorWithDetail(ctx context.Context, correlationID, code, errorCode, message string, retryable bool, detail *protocol.ErrorDetail) error {
	return d.sendTerminalFrame(ctx, &protocol.ErrorFrame{
		CorrelatedFrame: correlated(protocol.TypeError, correlationID),
		Code:            code,
		ErrorCode:       errorCode,
		Message:         message,
		Retryable:       retryable,
		Detail:          detail,
	})
}

func protocolErrorDetail(detail runner.ErrorDetail) *protocol.ErrorDetail {
	if detail.HTTPStatus == nil && detail.DialError == "" && detail.Endpoint == "" && detail.RawMessage == "" {
		return nil
	}
	return &protocol.ErrorDetail{
		HTTPStatus: detail.HTTPStatus,
		DialError:  detail.DialError,
		Endpoint:   detail.Endpoint,
		RawMessage: detail.RawMessage,
	}
}

func providerErrorCode(err *runner.Error) string {
	if err == nil {
		return ""
	}
	if strings.HasPrefix(err.Code, "provider_") {
		return err.Code
	}
	text := strings.ToLower(strings.Join([]string{err.Code, err.Message, err.Detail.RawMessage}, " "))
	if contentRefused(text) {
		return "provider_content_refused"
	}

	switch err.StatusCode {
	case httpStatusTooManyRequests:
		return "provider_rate_limited"
	case httpStatusRequestTimeout:
		return "provider_timeout"
	case httpStatusUnauthorized, httpStatusForbidden:
		return "provider_auth_failed"
	case httpStatusBadRequest, httpStatusUnprocessableEntity:
		return "provider_invalid_request"
	case httpStatusInternalServerError, httpStatusBadGateway, httpStatusServiceUnavailable, httpStatusGatewayTimeout:
		return "provider_overloaded"
	}

	switch err.Kind {
	case runner.ErrorKindEndpointUnavailable:
		return "provider_timeout"
	case runner.ErrorKindModelNotFound:
		return ""
	case runner.ErrorKindProvider:
		return "provider_unknown"
	default:
		return ""
	}
}

func contentRefused(text string) bool {
	return strings.Contains(text, "content_filter") ||
		strings.Contains(text, "content filter") ||
		strings.Contains(text, "content policy") ||
		strings.Contains(text, "policy_violation") ||
		strings.Contains(text, "refusal") ||
		strings.Contains(text, "refused")
}

func providerErrorRetryable(code string) bool {
	switch code {
	case "provider_rate_limited", "provider_timeout", "provider_overloaded", "provider_stream_interrupted", "provider_content_refused", "provider_unknown":
		return true
	default:
		return false
	}
}

const (
	httpStatusBadRequest          = 400
	httpStatusUnauthorized        = 401
	httpStatusForbidden           = 403
	httpStatusRequestTimeout      = 408
	httpStatusUnprocessableEntity = 422
	httpStatusTooManyRequests     = 429
	httpStatusInternalServerError = 500
	httpStatusBadGateway          = 502
	httpStatusServiceUnavailable  = 503
	httpStatusGatewayTimeout      = 504
)

func (d *Dispatcher) sendTerminalFrame(ctx context.Context, frame protocol.Frame) error {
	sendCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), d.terminalSendTimeout)
	defer cancel()
	return d.sender.SendFrame(sendCtx, frame)
}

func correlated(frameType, correlationID string) protocol.CorrelatedFrame {
	return protocol.CorrelatedFrame{
		BaseFrame:     protocol.BaseFrame{Type: frameType, SchemaVersion: protocol.SchemaVersion},
		CorrelationID: correlationID,
	}
}

func outputContent(event runner.Event) string {
	if event.Output != "" {
		return event.Output
	}
	if event.Message != "" {
		return event.Message
	}
	if event.Payload != nil {
		data, err := json.Marshal(event.Payload)
		if err == nil {
			return string(data)
		}
	}
	return ""
}

func marshalResult(value any) json.RawMessage {
	if value == nil {
		return nil
	}
	data, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	return data
}

func protocolToolCalls(calls []runner.ToolCall) []protocol.ToolCallInfo {
	out := make([]protocol.ToolCallInfo, 0, len(calls))
	for _, call := range calls {
		out = append(out, protocol.ToolCallInfo{
			ID:              call.ID,
			Name:            call.Name,
			Arguments:       call.Arguments,
			GrantProvenance: protocolGrantProvenance(call.GrantProvenance),
		})
	}
	return out
}

func toolCallNames(calls []runner.ToolCall) []string {
	names := make([]string, 0, len(calls))
	for _, call := range calls {
		names = append(names, call.Name)
	}
	return names
}

func toolCallIDs(calls []runner.ToolCall) []string {
	ids := make([]string, 0, len(calls))
	for _, call := range calls {
		ids = append(ids, call.ID)
	}
	return ids
}

func summarizeToolCallResult(result *runner.ToolCallResult, limit int) string {
	if result == nil {
		return ""
	}
	return summarizeLogValue(map[string]any{
		"tool_call_id": result.ToolCallID,
		"success":      result.Success,
		"duration_ms":  result.DurationMs,
		"output":       result.Output,
	}, limit)
}

func summarizeLogValue(value any, limit int) string {
	if value == nil {
		return ""
	}
	data, err := json.Marshal(value)
	if err != nil {
		return fmt.Sprintf("%v", value)
	}
	text := string(data)
	if limit > 0 && len(text) > limit {
		return text[:limit] + "...[truncated]"
	}
	return text
}

func protocolGrantProvenance(provenance *runner.GrantProvenance) *protocol.GrantProvenance {
	if provenance == nil {
		return nil
	}
	return &protocol.GrantProvenance{
		AgentToolGrantID:     provenance.AgentToolGrantID,
		Source:               provenance.Source,
		SourceToolTemplateID: provenance.SourceToolTemplateID,
		Reason:               provenance.Reason,
		CreatedByUserID:      provenance.CreatedByUserID,
	}
}

// Diagnostics emits relay lifecycle events without exposing credentials.
type Diagnostics struct {
	Logger diagnostics.Logger
}

// ConnectionAttempt logs an outbound relay connection attempt.
func (d Diagnostics) ConnectionAttempt(endpoint string) error {
	return d.log(diagnostics.NewEvent(diagnostics.EventConnectionAttempt).
		WithEndpoint(endpoint))
}

// RegisterAck logs the cloud's registration acknowledgement.
func (d Diagnostics) RegisterAck(runnerKinds []string) error {
	return d.log(diagnostics.NewEvent(diagnostics.EventRegisterAck).
		WithField("runner_kinds", runnerKinds))
}

// DispatchStarted logs the start of a relay dispatch.
func (d Diagnostics) DispatchStarted(correlationID, runnerKind string) error {
	return d.log(diagnostics.NewEvent(diagnostics.EventDispatchStarted).
		WithCorrelation(correlationID).
		WithRunner(runnerKind, "", ""))
}

// DispatchCompleted logs successful relay dispatch completion.
func (d Diagnostics) DispatchCompleted(correlationID, runnerKind string) error {
	return d.log(diagnostics.NewEvent(diagnostics.EventDispatchCompleted).
		WithCorrelation(correlationID).
		WithRunner(runnerKind, "", ""))
}

// Cancellation logs cancel propagation for an in-flight dispatch.
func (d Diagnostics) Cancellation(correlationID, runnerKind string) error {
	return d.log(diagnostics.NewEvent(diagnostics.EventCancellation).
		WithCorrelation(correlationID).
		WithRunner(runnerKind, "", "").
		WithFailure(diagnostics.FailureCanceled, "dispatch canceled"))
}

func (d Diagnostics) log(event diagnostics.EventEnvelope) error {
	if d.Logger == nil {
		return nil
	}
	return d.Logger.Log(event)
}
