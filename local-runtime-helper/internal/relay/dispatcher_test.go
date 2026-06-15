package relay

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/kmgrassi/local-runtime-helper/internal/protocol"
	"github.com/kmgrassi/local-runtime-helper/internal/runner"
)

type fakeToolExecutor struct {
	gotReq      runner.ToolCallRequest
	gotDeadline bool
	result      runner.ToolCallResult
}

func (f *fakeToolExecutor) Execute(ctx context.Context, req runner.ToolCallRequest) runner.ToolCallResult {
	f.gotReq = req
	_, f.gotDeadline = ctx.Deadline()
	res := f.result
	res.ToolCallID = req.ToolCallID
	return res
}

func toolExecRequest(correlationID, toolCallID string) *protocol.ToolExecutionRequestFrame {
	return &protocol.ToolExecutionRequestFrame{
		CorrelatedFrame: correlated(protocol.TypeToolExecRequest, correlationID),
		ToolCallID:      toolCallID,
		Name:            "git.run",
		Arguments:       map[string]any{"argv": []any{"gh", "pr", "list"}},
		Context:         map[string]any{"workspace_id": "workspace-1", "agent_id": "agent-1"},
		ExecutionKind:   "helper",
	}
}

func TestHandleFrameExecutesDelegatedToolAndReturnsResult(t *testing.T) {
	sender := &recordingSender{}
	exec := &fakeToolExecutor{result: runner.ToolCallResult{Success: true, Output: map[string]any{"ok": true}, DurationMs: 7}}

	registry, err := runner.NewRegistry()
	if err != nil {
		t.Fatalf("new registry: %v", err)
	}
	dispatcher, err := NewDispatcher(DispatcherOptions{Runners: registry, Sender: sender, ToolExecutor: exec})
	if err != nil {
		t.Fatalf("new dispatcher: %v", err)
	}

	if err := dispatcher.HandleFrame(context.Background(), toolExecRequest("c1", "call-1")); err != nil {
		t.Fatalf("handle frame: %v", err)
	}
	dispatcher.Wait()

	if exec.gotReq.Name != "git.run" || exec.gotReq.ToolCallID != "call-1" {
		t.Fatalf("executor got %+v, want git.run / call-1", exec.gotReq)
	}
	if exec.gotReq.Context["workspace_id"] != "workspace-1" || exec.gotReq.Context["agent_id"] != "agent-1" {
		t.Fatalf("executor context = %+v", exec.gotReq.Context)
	}

	frame, ok := sender.only(t).(*protocol.ToolCallResultFrame)
	if !ok {
		t.Fatalf("frame type = %T, want *ToolCallResultFrame", sender.frames[0])
	}
	if !frame.Success || frame.ToolCallID != "call-1" || frame.CorrelationID != "c1" || frame.DurationMs != 7 {
		t.Fatalf("result frame = %#v", frame)
	}
}

func TestHandleFrameToolExecutionBindsRequestTimeout(t *testing.T) {
	sender := &recordingSender{}
	exec := &fakeToolExecutor{result: runner.ToolCallResult{Success: true}}

	registry, err := runner.NewRegistry()
	if err != nil {
		t.Fatalf("new registry: %v", err)
	}
	dispatcher, err := NewDispatcher(DispatcherOptions{Runners: registry, Sender: sender, ToolExecutor: exec})
	if err != nil {
		t.Fatalf("new dispatcher: %v", err)
	}

	req := toolExecRequest("c3", "call-3")
	req.TimeoutMs = 30_000
	if err := dispatcher.HandleFrame(context.Background(), req); err != nil {
		t.Fatalf("handle frame: %v", err)
	}
	dispatcher.Wait()

	if !exec.gotDeadline {
		t.Fatal("executor context had no deadline; request timeout was not bound to local execution")
	}
}

func TestHandleFrameToolExecutionWithoutExecutorReturnsError(t *testing.T) {
	sender := &recordingSender{}
	registry, err := runner.NewRegistry()
	if err != nil {
		t.Fatalf("new registry: %v", err)
	}
	dispatcher, err := NewDispatcher(DispatcherOptions{Runners: registry, Sender: sender}) // no ToolExecutor
	if err != nil {
		t.Fatalf("new dispatcher: %v", err)
	}

	if err := dispatcher.HandleFrame(context.Background(), toolExecRequest("c2", "call-2")); err != nil {
		t.Fatalf("handle frame: %v", err)
	}
	dispatcher.Wait()

	frame, ok := sender.only(t).(*protocol.ToolCallResultFrame)
	if !ok {
		t.Fatalf("frame type = %T, want *ToolCallResultFrame", sender.frames[0])
	}
	if frame.Success {
		t.Fatal("result success = true, want false when no executor is configured")
	}
	output, _ := frame.Output.(map[string]any)
	if output["error"] != "no_local_tool_executor" {
		t.Fatalf("output error = %v, want no_local_tool_executor", output["error"])
	}
}

func TestDispatcherRunsMultipleDispatches(t *testing.T) {
	sender := &recordingSender{}
	firstStarted := make(chan struct{})
	release := make(chan struct{})
	runCount := 0
	runCountMu := sync.Mutex{}

	fake := fakeRunner{
		kind: "fake",
		dispatch: func(ctx context.Context, input any, emit func(any) error) error {
			runCountMu.Lock()
			runCount++
			if runCount == 1 {
				close(firstStarted)
			}
			runCountMu.Unlock()
			if err := emit(runner.Event{Kind: runner.EventProgress, Message: "started"}); err != nil {
				return err
			}
			<-release
			return nil
		},
	}

	dispatcher := newTestDispatcher(t, sender, 2, 0, fake)
	if err := dispatcher.StartDispatch(context.Background(), dispatch("c1", "fake")); err != nil {
		t.Fatalf("start first dispatch: %v", err)
	}
	<-firstStarted
	if err := dispatcher.StartDispatch(context.Background(), dispatch("c2", "fake")); err != nil {
		t.Fatalf("start second dispatch: %v", err)
	}
	close(release)
	dispatcher.Wait()

	completeCount := sender.count(protocol.TypeComplete)
	if completeCount != 2 {
		t.Fatalf("complete frames = %d, want 2; frames = %#v", completeCount, sender.frames)
	}
}

func TestDispatcherUnknownRunnerEmitsTypedError(t *testing.T) {
	sender := &recordingSender{}
	dispatcher := newTestDispatcher(t, sender, 1, 0)

	if err := dispatcher.StartDispatch(context.Background(), dispatch("c1", "missing")); err != nil {
		t.Fatalf("start dispatch: %v", err)
	}
	dispatcher.Wait()

	frame := sender.only(t).(*protocol.ErrorFrame)
	if frame.Code != "unknown_runner_kind" {
		t.Fatalf("error code = %q, want unknown_runner_kind", frame.Code)
	}
	if frame.CorrelationID != "c1" {
		t.Fatalf("correlation_id = %q, want c1", frame.CorrelationID)
	}
}

func TestDispatcherEmitsCanonicalProviderErrorCode(t *testing.T) {
	sender := &recordingSender{}
	fake := fakeRunner{
		kind: "openai_compatible",
		dispatch: func(ctx context.Context, input any, emit func(any) error) error {
			return &runner.Error{
				Kind:       runner.ErrorKindProvider,
				Message:    "ollama rate limit exceeded",
				StatusCode: 429,
			}
		},
	}

	dispatcher := newTestDispatcher(t, sender, 1, 0, fake)
	if err := dispatcher.StartDispatch(context.Background(), dispatch("c1", "openai_compatible")); err != nil {
		t.Fatalf("start dispatch: %v", err)
	}
	dispatcher.Wait()

	frame := sender.only(t).(*protocol.ErrorFrame)
	if frame.Code != "provider_error" {
		t.Fatalf("code = %q, want provider_error", frame.Code)
	}
	if frame.ErrorCode != "provider_rate_limited" {
		t.Fatalf("error_code = %q, want provider_rate_limited", frame.ErrorCode)
	}
	if !frame.Retryable {
		t.Fatal("retryable = false, want true")
	}
}

func TestDispatcherPreservesModelNotFoundErrorCode(t *testing.T) {
	sender := &recordingSender{}
	fake := fakeRunner{
		kind: "openai_compatible",
		dispatch: func(ctx context.Context, input any, emit func(any) error) error {
			return &runner.Error{
				Kind:       runner.ErrorKindModelNotFound,
				Message:    "model qwen is missing",
				StatusCode: 404,
			}
		},
	}

	dispatcher := newTestDispatcher(t, sender, 1, 0, fake)
	if err := dispatcher.StartDispatch(context.Background(), dispatch("c1", "openai_compatible")); err != nil {
		t.Fatalf("start dispatch: %v", err)
	}
	dispatcher.Wait()

	frame := sender.only(t).(*protocol.ErrorFrame)
	if frame.Code != "model_not_found" {
		t.Fatalf("code = %q, want model_not_found", frame.Code)
	}
	if frame.ErrorCode != "" {
		t.Fatalf("error_code = %q, want empty", frame.ErrorCode)
	}
}

func TestDispatcherRoutesLocalRelayDispatchToTargetRunnerKind(t *testing.T) {
	sender := &recordingSender{}
	gotPayload := make(chan any, 1)
	fake := fakeRunner{
		kind: "openai_compatible",
		dispatch: func(ctx context.Context, input any, emit func(any) error) error {
			gotPayload <- input
			return nil
		},
	}

	frame := dispatch("c1", "local_relay")
	frame.TargetRunnerKind = "openai_compatible"

	dispatcher := newTestDispatcher(t, sender, 1, 0, fake)
	if err := dispatcher.StartDispatch(context.Background(), frame); err != nil {
		t.Fatalf("start dispatch: %v", err)
	}
	dispatcher.Wait()

	select {
	case <-gotPayload:
	default:
		t.Fatal("target runner was not dispatched")
	}
	if got := sender.count(protocol.TypeComplete); got != 1 {
		t.Fatalf("complete frames = %d, want 1; frames = %#v", got, sender.frames)
	}
}

func TestDispatcherUsesFullDispatchFrameWhenPayloadIsAbsent(t *testing.T) {
	sender := &recordingSender{}
	gotPayload := make(chan any, 1)
	fake := fakeRunner{
		kind: "openai_compatible",
		dispatch: func(ctx context.Context, input any, emit func(any) error) error {
			gotPayload <- input
			return nil
		},
	}

	frame := dispatch("c1", "local_relay")
	frame.TargetRunnerKind = "openai_compatible"
	frame.Payload = nil

	dispatcher := newTestDispatcher(t, sender, 1, 0, fake)
	if err := dispatcher.StartDispatch(context.Background(), frame); err != nil {
		t.Fatalf("start dispatch: %v", err)
	}
	dispatcher.Wait()

	select {
	case got := <-gotPayload:
		if got != frame {
			t.Fatalf("payload = %#v, want original dispatch frame", got)
		}
	default:
		t.Fatal("target runner was not dispatched")
	}
}

func TestDispatcherTranslatesToolCallRequestEvent(t *testing.T) {
	sender := &recordingSender{}
	fake := fakeRunner{
		kind: "fake",
		dispatch: func(ctx context.Context, input any, emit func(any) error) error {
			return emit(runner.ToolCallRequestEvent{
				Kind: "tool_call_request",
				ToolCalls: []runner.ToolCall{{
					ID:        "call_123",
					Name:      "filesystem_read",
					Arguments: map[string]any{"path": "README.md"},
					GrantProvenance: &runner.GrantProvenance{
						AgentToolGrantID:     "grant_123",
						Source:               "template",
						SourceToolTemplateID: "template_coding",
						Reason:               "default coding tool",
						CreatedByUserID:      "user_123",
					},
				}},
			})
		},
	}

	dispatcher := newTestDispatcher(t, sender, 1, 0, fake)
	if err := dispatcher.StartDispatch(context.Background(), dispatch("c1", "fake")); err != nil {
		t.Fatalf("start dispatch: %v", err)
	}
	dispatcher.Wait()

	frame := sender.first(protocol.TypeToolCallRequest).(*protocol.ToolCallRequestFrame)
	if frame.CorrelationID != "c1" {
		t.Fatalf("correlation_id = %q, want c1", frame.CorrelationID)
	}
	if len(frame.ToolCalls) != 1 || frame.ToolCalls[0].Name != "filesystem_read" || frame.ToolCalls[0].Arguments["path"] != "README.md" {
		t.Fatalf("tool calls = %#v", frame.ToolCalls)
	}
	got := frame.ToolCalls[0].GrantProvenance
	if got == nil {
		t.Fatal("grant provenance = nil")
	}
	if got.AgentToolGrantID != "grant_123" || got.Source != "template" || got.SourceToolTemplateID != "template_coding" || got.Reason != "default coding tool" || got.CreatedByUserID != "user_123" {
		t.Fatalf("grant provenance = %#v", got)
	}
}

func TestDispatcherTranslatesOutputEventsToProgressAndCompleteOutput(t *testing.T) {
	sender := &recordingSender{}
	fake := fakeRunner{
		kind: "fake",
		dispatch: func(ctx context.Context, input any, emit func(any) error) error {
			if err := emit(runner.OutputEvent{Kind: "output", Text: "hel"}); err != nil {
				return err
			}
			if err := emit(runner.OutputEvent{Kind: "output", Text: "lo"}); err != nil {
				return err
			}
			return emit(runner.CompleteEvent{Kind: "complete", FinishReason: "stop"})
		},
	}

	dispatcher := newTestDispatcher(t, sender, 1, 0, fake)
	if err := dispatcher.StartDispatch(context.Background(), dispatch("c1", "fake")); err != nil {
		t.Fatalf("start dispatch: %v", err)
	}
	dispatcher.Wait()

	first := sender.first(protocol.TypeProgress).(*protocol.ProgressFrame)
	if first.Event != "message.delta" || first.Text != "hel" {
		t.Fatalf("first progress = %#v, want message.delta hel", first)
	}
	complete := sender.first(protocol.TypeComplete).(*protocol.CompleteFrame)
	var result map[string]any
	if err := json.Unmarshal(complete.Result, &result); err != nil {
		t.Fatalf("decode complete result: %v", err)
	}
	if result["output_text"] != "hello" {
		t.Fatalf("output_text = %#v, want hello", result["output_text"])
	}
}

func TestDispatcherCancelStopsRunner(t *testing.T) {
	sender := &recordingSender{}
	started := make(chan struct{})
	stopped := make(chan struct{})
	fake := fakeRunner{
		kind: "fake",
		dispatch: func(ctx context.Context, input any, emit func(any) error) error {
			close(started)
			<-ctx.Done()
			close(stopped)
			return ctx.Err()
		},
	}

	dispatcher := newTestDispatcher(t, sender, 1, 0, fake)
	if err := dispatcher.StartDispatch(context.Background(), dispatch("c1", "fake")); err != nil {
		t.Fatalf("start dispatch: %v", err)
	}
	<-started
	dispatcher.Cancel("c1")

	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("runner did not observe cancellation")
	}
	dispatcher.Wait()

	if got := sender.lastErrorCode(); got != "canceled" {
		t.Fatalf("last error code = %q, want canceled; frames = %#v", got, sender.frames)
	}
}

func TestDispatcherCancelFrameEmitsAck(t *testing.T) {
	sender := &recordingSender{}
	dispatcher := newTestDispatcher(t, sender, 1, 0)

	if err := dispatcher.HandleFrame(context.Background(), &protocol.CancelFrame{
		CorrelatedFrame: protocol.CorrelatedFrame{
			BaseFrame:     protocol.BaseFrame{Type: protocol.TypeCancel, SchemaVersion: protocol.SchemaVersion},
			CorrelationID: "missing",
		},
	}); err != nil {
		t.Fatalf("handle cancel: %v", err)
	}

	frame := sender.only(t).(*protocol.CancelAckFrame)
	if frame.CorrelationID != "missing" {
		t.Fatalf("correlation id = %q, want missing", frame.CorrelationID)
	}
	if frame.Outcome != "not_found" {
		t.Fatalf("outcome = %q, want not_found", frame.Outcome)
	}
}

func TestDispatcherPropagatesRunnerErrorDetail(t *testing.T) {
	sender := &recordingSender{}
	status := 503
	fake := fakeRunner{
		kind: "fake",
		dispatch: func(ctx context.Context, input any, emit func(any) error) error {
			return &runner.Error{
				Kind:    runner.ErrorKindEndpointUnavailable,
				Message: "endpoint failed",
				Detail: runner.ErrorDetail{
					HTTPStatus: &status,
					DialError:  "connect: connection refused",
					Endpoint:   "http://127.0.0.1:11434/v1/chat/completions",
				},
			}
		},
	}

	dispatcher := newTestDispatcher(t, sender, 1, 0, fake)
	if err := dispatcher.StartDispatch(context.Background(), dispatch("c1", "fake")); err != nil {
		t.Fatalf("start dispatch: %v", err)
	}
	dispatcher.Wait()

	frame := sender.only(t).(*protocol.ErrorFrame)
	if frame.Code != string(runner.ErrorKindEndpointUnavailable) {
		t.Fatalf("error code = %q, want endpoint_unavailable", frame.Code)
	}
	if frame.Detail == nil {
		t.Fatal("error detail = nil")
	}
	if frame.Detail.HTTPStatus == nil || *frame.Detail.HTTPStatus != status {
		t.Fatalf("http status = %#v, want %d", frame.Detail.HTTPStatus, status)
	}
	if frame.Detail.DialError != "connect: connection refused" {
		t.Fatalf("dial error = %q", frame.Detail.DialError)
	}
}

func TestDispatcherConcurrencyLimitEmitsTypedError(t *testing.T) {
	sender := &recordingSender{}
	started := make(chan struct{})
	block := make(chan struct{})
	fake := fakeRunner{
		kind: "fake",
		dispatch: func(ctx context.Context, input any, emit func(any) error) error {
			close(started)
			<-block
			return nil
		},
	}

	dispatcher := newTestDispatcher(t, sender, 1, 0, fake)
	if err := dispatcher.StartDispatch(context.Background(), dispatch("c1", "fake")); err != nil {
		t.Fatalf("start first dispatch: %v", err)
	}
	<-started
	if err := dispatcher.StartDispatch(context.Background(), dispatch("c2", "fake")); err != nil {
		t.Fatalf("start second dispatch: %v", err)
	}
	close(block)
	dispatcher.Wait()

	if got := sender.firstErrorCode(); got != "concurrency_limit_exceeded" {
		t.Fatalf("first error code = %q, want concurrency_limit_exceeded; frames = %#v", got, sender.frames)
	}
}

func TestDispatcherTerminalSendUsesBoundedContext(t *testing.T) {
	sender := blockingSender{}
	fake := fakeRunner{
		kind: "fake",
		dispatch: func(ctx context.Context, input any, emit func(any) error) error {
			return errors.New("boom")
		},
	}

	dispatcher := newTestDispatcher(t, sender, 1, 20*time.Millisecond, fake)
	if err := dispatcher.StartDispatch(context.Background(), dispatch("c1", "fake")); err != nil {
		t.Fatalf("start dispatch: %v", err)
	}

	done := make(chan struct{})
	go func() {
		dispatcher.Wait()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("dispatcher did not finish after terminal send timeout")
	}
}

func newTestDispatcher(t *testing.T, sender Sender, maxConcurrent int, terminalSendTimeout time.Duration, runners ...runner.Runner) *Dispatcher {
	t.Helper()
	registry, err := runner.NewRegistry(runners...)
	if err != nil {
		t.Fatalf("new registry: %v", err)
	}
	dispatcher, err := NewDispatcher(DispatcherOptions{
		Runners:             registry,
		Sender:              sender,
		MaxConcurrent:       maxConcurrent,
		TerminalSendTimeout: terminalSendTimeout,
	})
	if err != nil {
		t.Fatalf("new dispatcher: %v", err)
	}
	return dispatcher
}

func dispatch(correlationID, kind string) *protocol.DispatchFrame {
	return &protocol.DispatchFrame{
		CorrelatedFrame: protocol.CorrelatedFrame{
			BaseFrame:     protocol.BaseFrame{Type: protocol.TypeDispatch, SchemaVersion: protocol.SchemaVersion},
			CorrelationID: correlationID,
		},
		RunnerKind: kind,
		Payload:    []byte(`{"ok":true}`),
	}
}

type fakeRunner struct {
	kind     string
	dispatch func(context.Context, any, func(any) error) error
}

func (f fakeRunner) Kind() string { return f.kind }

func (f fakeRunner) Dispatch(ctx context.Context, input any, emit func(any) error) error {
	if f.dispatch == nil {
		return errors.New("fake dispatch not implemented")
	}
	return f.dispatch(ctx, input, emit)
}

type recordingSender struct {
	mu     sync.Mutex
	frames []protocol.Frame
}

func (r *recordingSender) SendFrame(ctx context.Context, frame protocol.Frame) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.frames = append(r.frames, frame)
	return nil
}

func (r *recordingSender) only(t *testing.T) protocol.Frame {
	t.Helper()
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.frames) != 1 {
		t.Fatalf("frames = %d, want 1: %#v", len(r.frames), r.frames)
	}
	return r.frames[0]
}

func (r *recordingSender) count(frameType string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	count := 0
	for _, frame := range r.frames {
		if frameBaseType(frame) == frameType {
			count++
		}
	}
	return count
}

func (r *recordingSender) first(frameType string) protocol.Frame {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, frame := range r.frames {
		if frameBaseType(frame) == frameType {
			return frame
		}
	}
	return nil
}

func (r *recordingSender) firstErrorCode() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, frame := range r.frames {
		if errFrame, ok := frame.(*protocol.ErrorFrame); ok {
			return errFrame.Code
		}
	}
	return ""
}

func (r *recordingSender) lastErrorCode() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := len(r.frames) - 1; i >= 0; i-- {
		if errFrame, ok := r.frames[i].(*protocol.ErrorFrame); ok {
			return errFrame.Code
		}
	}
	return ""
}

type blockingSender struct{}

func (blockingSender) SendFrame(ctx context.Context, frame protocol.Frame) error {
	<-ctx.Done()
	return ctx.Err()
}

func frameBaseType(frame protocol.Frame) string {
	switch f := frame.(type) {
	case *protocol.ProgressFrame:
		return f.Type
	case *protocol.OutputFrame:
		return f.Type
	case *protocol.CompleteFrame:
		return f.Type
	case *protocol.ErrorFrame:
		return f.Type
	case *protocol.CancelAckFrame:
		return f.Type
	case *protocol.ToolCallRequestFrame:
		return f.Type
	default:
		return ""
	}
}
