package openai_compatible

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/kmgrassi/local-runtime-helper/internal/runner"
)

func TestDispatchHelperManagedToolLoop(t *testing.T) {
	attempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		var req chatRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if attempts == 1 {
			if len(req.Tools) != 1 {
				t.Fatalf("tools = %#v, want one tool", req.Tools)
			}
			_, _ = w.Write([]byte(`{"choices":[{"message":{"tool_calls":[{"id":"call_123","type":"function","function":{"name":"filesystem_read","arguments":"{\"path\":\"README.md\"}"}}]},"finish_reason":"tool_calls"}]}`))
			return
		}
		if got := req.Messages[len(req.Messages)-1].Role; got != "tool" {
			t.Fatalf("last message role = %q, want tool", got)
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"file summarized"},"finish_reason":"stop"}]}`))
	}))
	defer server.Close()

	executor := &fakeToolExecutor{result: runner.ToolCallResult{ToolCallID: "call_123", Success: true, Output: "contents", DurationMs: 2}}
	r, err := New(Config{Endpoint: server.URL + "/v1", Model: "local-model", ToolExecutor: executor})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	var events []any
	err = r.Dispatch(context.Background(), runner.ChatCompletionInput{
		Messages:        []runner.ChatMessage{{Role: "user", Content: "read"}},
		ToolCallingMode: "helper_managed",
		ToolDefinitions: []runner.ToolDefinition{{
			Name:             "filesystem_read",
			Description:      "Read a workspace file",
			ParametersSchema: map[string]any{"type": "object"},
			ExecutionKind:    "helper",
		}},
	}, func(event any) error {
		events = append(events, event)
		return nil
	})
	if err != nil {
		t.Fatalf("Dispatch() error = %v", err)
	}
	if executor.calls != 1 {
		t.Fatalf("executor calls = %d, want 1", executor.calls)
	}
	if attempts != 2 {
		t.Fatalf("attempts = %d, want 2", attempts)
	}
	assertOutput(t, events, "file summarized")
}

func TestDispatchHelperManagedRawLoggingCapturesToolLoopResponses(t *testing.T) {
	t.Setenv(rawModelIOEnvVar, "true")

	attempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		if attempts == 1 {
			_, _ = w.Write([]byte(`{"choices":[{"message":{"tool_calls":[{"id":"call_123","type":"function","function":{"name":"filesystem_read","arguments":"{\"path\":\"README.md\"}"}}]},"finish_reason":"tool_calls"}]}`))
			return
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"file summarized"},"finish_reason":"stop"}]}`))
	}))
	defer server.Close()

	var logs bytes.Buffer
	executor := &fakeToolExecutor{result: runner.ToolCallResult{ToolCallID: "call_123", Success: true, Output: "contents"}}
	r, err := New(Config{
		Endpoint:     server.URL + "/v1",
		Model:        "local-model",
		ToolExecutor: executor,
		Logger:       slog.New(slog.NewTextHandler(&logs, nil)),
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	err = r.Dispatch(context.Background(), runner.ChatCompletionInput{
		Messages:        []runner.ChatMessage{{Role: "user", Content: "read"}},
		ToolCallingMode: "helper_managed",
		ToolDefinitions: []runner.ToolDefinition{{
			Name:          "filesystem_read",
			ExecutionKind: "helper",
		}},
	}, func(event any) error { return nil })
	if err != nil {
		t.Fatalf("Dispatch() error = %v", err)
	}

	logOutput := logs.String()
	if !strings.Contains(logOutput, "local model response") {
		t.Fatalf("logs did not include model responses:\n%s", logOutput)
	}
	if !strings.Contains(logOutput, "call_123") {
		t.Fatalf("logs did not capture tool-call response:\n%s", logOutput)
	}
	if !strings.Contains(logOutput, "file summarized") {
		t.Fatalf("logs did not capture final completion response:\n%s", logOutput)
	}
}

func TestDispatchHelperManagedReturnsAbsentNativeToolAsResult(t *testing.T) {
	attempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		if attempts == 1 {
			_, _ = w.Write([]byte(`{"choices":[{"message":{"tool_calls":[{"id":"call_shell","type":"function","function":{"name":"shell.exec","arguments":"{\"command\":\"pwd\"}"}}]},"finish_reason":"tool_calls"}]}`))
			return
		}
		var req chatRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if got := req.Messages[len(req.Messages)-1].Content; !strings.Contains(got, `"undefined_tool"`) {
			t.Fatalf("last message content = %q, want undefined_tool result", got)
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"shell.exec is not available."},"finish_reason":"stop"}]}`))
	}))
	defer server.Close()

	executor := &fakeToolExecutor{result: runner.ToolCallResult{Success: true}}
	r, err := New(Config{Endpoint: server.URL + "/v1", Model: "local-model", ToolExecutor: executor})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	var events []any
	err = r.Dispatch(context.Background(), runner.ChatCompletionInput{
		Messages:        []runner.ChatMessage{{Role: "user", Content: "run"}},
		ToolCallingMode: "helper_managed",
		ToolDefinitions: []runner.ToolDefinition{{
			Name:          "filesystem_read",
			ExecutionKind: "helper",
		}},
	}, func(event any) error {
		events = append(events, event)
		return nil
	})
	if err != nil {
		t.Fatalf("Dispatch() error = %v", err)
	}
	assertOutput(t, events, "shell.exec is not available.")
	assertToolFailure(t, events, "call_shell", "undefined_tool")
	if executor.calls != 0 {
		t.Fatalf("executor calls = %d, want 0", executor.calls)
	}
}

func TestDispatchHelperManagedPromptFallback(t *testing.T) {
	attempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		var req chatRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if attempts == 1 {
			if len(req.Tools) == 0 {
				t.Fatal("first request did not include native tools")
			}
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":{"message":"tools are not supported","code":"unsupported_tools"}}`))
			return
		}
		if len(req.Tools) != 0 {
			t.Fatalf("fallback tools = %#v, want none", req.Tools)
		}
		if req.Messages[0].Role != "system" {
			t.Fatalf("first fallback message role = %q, want system", req.Messages[0].Role)
		}
		if attempts == 2 {
			_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"tool_call\":{\"id\":\"call_prompt\",\"name\":\"filesystem_read\",\"arguments\":{\"path\":\"README.md\"}}}"},"finish_reason":"stop"}]}`))
			return
		}
		if got := req.Messages[len(req.Messages)-1].Role; got != "tool" {
			t.Fatalf("last message role = %q, want tool", got)
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"fallback answer"},"finish_reason":"stop"}]}`))
	}))
	defer server.Close()

	executor := &fakeToolExecutor{result: runner.ToolCallResult{ToolCallID: "call_prompt", Success: true, Output: "contents"}}
	r, err := New(Config{Endpoint: server.URL + "/v1", Model: "local-model", ToolExecutor: executor})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	var events []any
	err = r.Dispatch(context.Background(), runner.ChatCompletionInput{
		Messages:        []runner.ChatMessage{{Role: "user", Content: "read"}},
		ToolCallingMode: "helper_managed",
		ToolDefinitions: []runner.ToolDefinition{{
			Name:             "filesystem_read",
			ParametersSchema: map[string]any{"type": "object"},
			ExecutionKind:    "helper",
		}},
	}, func(event any) error {
		events = append(events, event)
		return nil
	})
	if err != nil {
		t.Fatalf("Dispatch() error = %v", err)
	}
	if executor.calls != 1 {
		t.Fatalf("executor calls = %d, want 1", executor.calls)
	}
	assertOutput(t, events, "fallback answer")
}

func TestDispatchHelperManagedPromptFallbackReturnsAbsentToolAsResult(t *testing.T) {
	attempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		if attempts == 1 {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":{"message":"tools are not supported","code":"unsupported_tools"}}`))
			return
		}
		if attempts == 2 {
			_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"tool_call\":{\"id\":\"call_shell\",\"name\":\"shell.exec\",\"arguments\":{\"command\":\"pwd\"}}}"},"finish_reason":"stop"}]}`))
			return
		}
		var req chatRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if got := req.Messages[len(req.Messages)-1].Content; !strings.Contains(got, `"undefined_tool"`) {
			t.Fatalf("last message content = %q, want undefined_tool result", got)
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"shell.exec is not available."},"finish_reason":"stop"}]}`))
	}))
	defer server.Close()

	executor := &fakeToolExecutor{result: runner.ToolCallResult{Success: true}}
	r, err := New(Config{Endpoint: server.URL + "/v1", Model: "local-model", ToolExecutor: executor})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	var events []any
	err = r.Dispatch(context.Background(), runner.ChatCompletionInput{
		Messages:        []runner.ChatMessage{{Role: "user", Content: "run"}},
		ToolCallingMode: "helper_managed",
		ToolDefinitions: []runner.ToolDefinition{{
			Name:          "filesystem_read",
			ExecutionKind: "helper",
		}},
	}, func(event any) error {
		events = append(events, event)
		return nil
	})
	if err != nil {
		t.Fatalf("Dispatch() error = %v", err)
	}
	assertOutput(t, events, "shell.exec is not available.")
	assertToolFailure(t, events, "call_shell", "undefined_tool")
	if executor.calls != 0 {
		t.Fatalf("executor calls = %d, want 0", executor.calls)
	}
}

func TestDispatchHelperManagedDelegatesRuntimeTool(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"choices":[{"message":{"tool_calls":[{"id":"call_runtime_1","type":"function","function":{"name":"task.create","arguments":"{\"title\":\"Plan\"}"}},{"id":"call_runtime_2","type":"function","function":{"name":"task.update","arguments":"{\"id\":\"task-1\"}"}}]},"finish_reason":"tool_calls"}]}`))
	}))
	defer server.Close()

	executor := &fakeToolExecutor{result: runner.ToolCallResult{Success: true}}
	r, err := New(Config{Endpoint: server.URL + "/v1", Model: "local-model", ToolExecutor: executor})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	var events []any
	err = r.Dispatch(context.Background(), runner.ChatCompletionInput{
		Messages:        []runner.ChatMessage{{Role: "user", Content: "create"}},
		ToolCallingMode: "helper_managed",
		ToolDefinitions: []runner.ToolDefinition{{
			Name:             "task.create",
			ParametersSchema: map[string]any{"type": "object"},
			ExecutionKind:    "runtime",
		}, {
			Name:             "task.update",
			ParametersSchema: map[string]any{"type": "object"},
			ExecutionKind:    "runtime",
		}},
	}, func(event any) error {
		events = append(events, event)
		return nil
	})
	if err != nil {
		t.Fatalf("Dispatch() error = %v", err)
	}
	if executor.calls != 0 {
		t.Fatalf("executor calls = %d, want 0", executor.calls)
	}
	event, ok := events[0].(runner.ToolCallRequestEvent)
	if !ok {
		t.Fatalf("event = %T, want ToolCallRequestEvent", events[0])
	}
	if len(event.ToolCalls) != 2 {
		t.Fatalf("tool calls = %#v, want two forwarded calls", event.ToolCalls)
	}
	if event.ToolCalls[0].Name != "task.create" || event.ToolCalls[1].Name != "task.update" {
		t.Fatalf("tool calls = %#v", event.ToolCalls)
	}
}

func TestDispatchHelperManagedExecutesHelperAndForwardsRuntimeTools(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"choices":[{"message":{"tool_calls":[{"id":"call_helper","type":"function","function":{"name":"repo.search","arguments":"{\"query\":\"TODO\"}"}},{"id":"call_runtime","type":"function","function":{"name":"task.create","arguments":"{\"title\":\"Follow up\"}"}}]},"finish_reason":"tool_calls"}]}`))
	}))
	defer server.Close()

	executor := &fakeToolExecutor{result: runner.ToolCallResult{Success: true, Output: "matches"}}
	r, err := New(Config{Endpoint: server.URL + "/v1", Model: "local-model", ToolExecutor: executor})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	var events []any
	err = r.Dispatch(context.Background(), runner.ChatCompletionInput{
		Messages:        []runner.ChatMessage{{Role: "user", Content: "plan"}},
		ToolCallingMode: "helper_managed",
		ToolDefinitions: []runner.ToolDefinition{{
			Name:             "repo.search",
			ParametersSchema: map[string]any{"type": "object"},
			ExecutionKind:    "helper",
		}, {
			Name:             "task.create",
			ParametersSchema: map[string]any{"type": "object"},
			ExecutionKind:    "runtime",
		}},
	}, func(event any) error {
		events = append(events, event)
		return nil
	})
	if err != nil {
		t.Fatalf("Dispatch() error = %v", err)
	}
	if executor.calls != 1 {
		t.Fatalf("executor calls = %d, want 1", executor.calls)
	}
	event, ok := events[len(events)-1].(runner.ToolCallRequestEvent)
	if !ok {
		t.Fatalf("last event = %T, want ToolCallRequestEvent; events = %#v", events[len(events)-1], events)
	}
	if len(event.ToolCalls) != 1 || event.ToolCalls[0].Name != "task.create" {
		t.Fatalf("tool calls = %#v", event.ToolCalls)
	}
}
