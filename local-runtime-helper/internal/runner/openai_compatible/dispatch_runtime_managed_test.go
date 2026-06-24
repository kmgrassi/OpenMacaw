package openai_compatible

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/kmgrassi/local-runtime-helper/internal/runner"
)

func TestDispatchRuntimeManagedParsesTaggedTextToolCall(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"I'll check.\n\n<function=scheduled_task.list>\n<parameter=due_only>\ntrue\n</parameter>\n</function>\n<function=scheduled_task.read>\n<parameter=scheduledTaskId>\n\"task-1\"\n</parameter>\n</function>\n</tool_call>"},"finish_reason":"stop"}]}`))
	}))
	defer server.Close()

	r, err := New(Config{Endpoint: server.URL + "/v1", Model: "local-model"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	var events []any
	err = r.Dispatch(context.Background(), runner.ChatCompletionInput{
		Messages:        []runner.ChatMessage{{Role: "user", Content: "list schedules"}},
		ToolCallingMode: "runtime_managed",
		ToolDefinitions: []runner.ToolDefinition{{
			Name:          "scheduled_task.list",
			ExecutionKind: "runtime",
		}, {
			Name:          "scheduled_task.read",
			ExecutionKind: "runtime",
		}},
	}, func(event any) error {
		events = append(events, event)
		return nil
	})
	if err != nil {
		t.Fatalf("Dispatch() error = %v", err)
	}

	event, ok := events[0].(runner.ToolCallRequestEvent)
	if !ok {
		t.Fatalf("event = %T, want ToolCallRequestEvent", events[0])
	}
	if len(event.ToolCalls) != 2 {
		t.Fatalf("tool calls = %#v", event.ToolCalls)
	}
	if event.ToolCalls[0].Name != "scheduled_task.list" || event.ToolCalls[1].Name != "scheduled_task.read" {
		t.Fatalf("tool call names = %#v", event.ToolCalls)
	}
	if event.ToolCalls[0].Arguments["due_only"] != true {
		t.Fatalf("arguments = %#v", event.ToolCalls[0].Arguments)
	}
	if event.ToolCalls[1].Arguments["scheduledTaskId"] != "task-1" {
		t.Fatalf("arguments = %#v", event.ToolCalls[1].Arguments)
	}
}

func TestDispatchRuntimeManagedParsesRepoReadFileTaggedTextToolCall(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"I'll read the README.md file to find the first heading.\n\n<function=shell.exec>\n<parameter=path>\nREADME.md\n</parameter>\n<parameter=workspace_id>\n7a5d31a8-2ffd-4fd2-ab12-a3c4f7e83b47\n</parameter>\n</function>\n</tool_call>"},"finish_reason":"stop"}]}`))
	}))
	defer server.Close()

	r, err := New(Config{Endpoint: server.URL + "/v1", Model: "local-model"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	var events []any
	err = r.Dispatch(context.Background(), runner.ChatCompletionInput{
		Messages:        []runner.ChatMessage{{Role: "user", Content: "read README"}},
		ToolCallingMode: "runtime_managed",
		ToolDefinitions: []runner.ToolDefinition{{
			Name:          "shell.exec",
			ExecutionKind: "runtime",
		}},
	}, func(event any) error {
		events = append(events, event)
		return nil
	})
	if err != nil {
		t.Fatalf("Dispatch() error = %v", err)
	}

	event, ok := events[0].(runner.ToolCallRequestEvent)
	if !ok {
		t.Fatalf("event = %T, want ToolCallRequestEvent", events[0])
	}
	if len(event.ToolCalls) != 1 {
		t.Fatalf("tool calls = %#v", event.ToolCalls)
	}
	call := event.ToolCalls[0]
	if call.Name != "shell.exec" {
		t.Fatalf("tool call name = %q, want shell.exec", call.Name)
	}
	if call.Arguments["path"] != "README.md" {
		t.Fatalf("path argument = %#v, want README.md", call.Arguments["path"])
	}
	if call.Arguments["workspace_id"] != "7a5d31a8-2ffd-4fd2-ab12-a3c4f7e83b47" {
		t.Fatalf("workspace_id argument = %#v", call.Arguments["workspace_id"])
	}
}

func TestDispatchRuntimeManagedReturnsAbsentToolAsResultBeforeForwarding(t *testing.T) {
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

	r, err := New(Config{Endpoint: server.URL + "/v1", Model: "local-model"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	var events []any
	err = r.Dispatch(context.Background(), runner.ChatCompletionInput{
		Messages:        []runner.ChatMessage{{Role: "user", Content: "run"}},
		ToolCallingMode: "runtime_managed",
		ProviderToolSpecs: []runner.ToolSpec{{
			Type:     "function",
			Function: runner.ToolFunction{Name: "shell.exec"},
		}},
		ToolDefinitions: []runner.ToolDefinition{{
			Name:          "filesystem_read",
			ExecutionKind: "runtime",
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
}

func TestDispatchRuntimeManagedDelegatesHelperTool(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"choices":[{"message":{"tool_calls":[{"id":"call_helper","type":"function","function":{"name":"shell.exec","arguments":"{\"command\":\"pwd\"}"}}]},"finish_reason":"tool_calls"}]}`))
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
		ToolCallingMode: "runtime_managed",
		ToolDefinitions: []runner.ToolDefinition{{
			Name:             "shell.exec",
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
	if executor.calls != 0 {
		t.Fatalf("executor calls = %d, want 0", executor.calls)
	}
	event, ok := events[0].(runner.ToolCallRequestEvent)
	if !ok {
		t.Fatalf("event = %T, want ToolCallRequestEvent", events[0])
	}
	if len(event.ToolCalls) != 1 || event.ToolCalls[0].Name != "shell.exec" {
		t.Fatalf("tool calls = %#v", event.ToolCalls)
	}
}

func TestDispatchRuntimeManagedForwardsGrantProvenance(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"choices":[{"message":{"tool_calls":[{"id":"call_helper","type":"function","function":{"name":"shell.exec","arguments":"{\"command\":\"pwd\"}"}}]},"finish_reason":"tool_calls"}]}`))
	}))
	defer server.Close()

	r, err := New(Config{Endpoint: server.URL + "/v1", Model: "local-model"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	var events []any
	err = r.Dispatch(context.Background(), runner.ChatCompletionInput{
		Messages:        []runner.ChatMessage{{Role: "user", Content: "run"}},
		ToolCallingMode: "runtime_managed",
		ToolDefinitions: []runner.ToolDefinition{{
			Name:             "shell.exec",
			ParametersSchema: map[string]any{"type": "object"},
			ExecutionKind:    "helper",
			GrantProvenance: &runner.GrantProvenance{
				AgentToolGrantID:     "grant_123",
				Source:               "template",
				SourceToolTemplateID: "template_coding",
				Reason:               "default coding tool",
				CreatedByUserID:      "user_123",
			},
		}},
	}, func(event any) error {
		events = append(events, event)
		return nil
	})
	if err != nil {
		t.Fatalf("Dispatch() error = %v", err)
	}

	event, ok := events[0].(runner.ToolCallRequestEvent)
	if !ok {
		t.Fatalf("event = %T, want ToolCallRequestEvent", events[0])
	}
	if len(event.ToolCalls) != 1 {
		t.Fatalf("tool calls = %#v, want one", event.ToolCalls)
	}
	got := event.ToolCalls[0].GrantProvenance
	if got == nil {
		t.Fatal("grant provenance = nil")
	}
	if got.AgentToolGrantID != "grant_123" || got.Source != "template" || got.SourceToolTemplateID != "template_coding" || got.Reason != "default coding tool" || got.CreatedByUserID != "user_123" {
		t.Fatalf("grant provenance = %#v", got)
	}
}

func TestDispatchRuntimeManagedMapsProviderSafeToolNameToRuntimeName(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"choices":[{"message":{"tool_calls":[{"id":"call_git","type":"function","function":{"name":"git_run","arguments":"{\"command\":\"gh pr list --repo kmgrassi/OpenMacaw --state open --json number --jq length\"}"}}]},"finish_reason":"tool_calls"}]}`))
	}))
	defer server.Close()

	r, err := New(Config{Endpoint: server.URL + "/v1", Model: "local-model"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	var events []any
	err = r.Dispatch(context.Background(), runner.ChatCompletionInput{
		Messages:        []runner.ChatMessage{{Role: "user", Content: "count PRs"}},
		ToolCallingMode: "runtime_managed",
		ProviderToolSpecs: []runner.ToolSpec{{
			Type:     "function",
			Function: runner.ToolFunction{Name: "git_run"},
		}},
		ToolDefinitions: []runner.ToolDefinition{{
			Name:             "git.run",
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

	event, ok := events[0].(runner.ToolCallRequestEvent)
	if !ok {
		t.Fatalf("event = %T, want ToolCallRequestEvent", events[0])
	}
	if len(event.ToolCalls) != 1 {
		t.Fatalf("tool calls = %#v, want one", event.ToolCalls)
	}
	call := event.ToolCalls[0]
	if call.Name != "git.run" {
		t.Fatalf("tool call name = %q, want git.run", call.Name)
	}
	if call.Arguments["command"] != "gh pr list --repo kmgrassi/OpenMacaw --state open --json number --jq length" {
		t.Fatalf("arguments = %#v", call.Arguments)
	}
}

func TestDispatchRuntimeManagedMapsCollisionSuffixedProviderToolName(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"choices":[{"message":{"tool_calls":[{"id":"call_task","type":"function","function":{"name":"task_create_1","arguments":"{\"name\":\"Follow up\"}"}}]},"finish_reason":"tool_calls"}]}`))
	}))
	defer server.Close()

	r, err := New(Config{Endpoint: server.URL + "/v1", Model: "local-model"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	var events []any
	err = r.Dispatch(context.Background(), runner.ChatCompletionInput{
		Messages:        []runner.ChatMessage{{Role: "user", Content: "create task"}},
		ToolCallingMode: "runtime_managed",
		ProviderToolSpecs: []runner.ToolSpec{{
			Type:     "function",
			Function: runner.ToolFunction{Name: "task_create"},
		}, {
			Type:     "function",
			Function: runner.ToolFunction{Name: "task_create_1"},
		}},
		ToolDefinitions: []runner.ToolDefinition{{
			Name:             "task.create",
			ParametersSchema: map[string]any{"type": "object"},
			ExecutionKind:    "runtime",
		}, {
			Name:             "task_create",
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

	event, ok := events[0].(runner.ToolCallRequestEvent)
	if !ok {
		t.Fatalf("event = %T, want ToolCallRequestEvent", events[0])
	}
	if len(event.ToolCalls) != 1 {
		t.Fatalf("tool calls = %#v, want one", event.ToolCalls)
	}
	call := event.ToolCalls[0]
	if call.Name != "task_create" {
		t.Fatalf("tool call name = %q, want task_create", call.Name)
	}
	if call.Arguments["name"] != "Follow up" {
		t.Fatalf("arguments = %#v", call.Arguments)
	}
}

func TestDispatchRuntimeManagedReturnsAbsentToolAsResult(t *testing.T) {
	attempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		if attempts == 1 {
			_, _ = w.Write([]byte(`{"choices":[{"message":{"tool_calls":[{"id":"call_absent","type":"function","function":{"name":"shell.exec","arguments":"{\"command\":\"pwd\"}"}}]},"finish_reason":"tool_calls"}]}`))
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

	r, err := New(Config{Endpoint: server.URL + "/v1", Model: "local-model"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	stream := false
	var events []any
	err = r.Dispatch(context.Background(), runner.ChatCompletionInput{
		Messages:        []runner.ChatMessage{{Role: "user", Content: "run"}},
		Stream:          &stream,
		ToolCallingMode: "runtime_managed",
		ToolDefinitions: []runner.ToolDefinition{{
			Name:             "scheduled_task.list",
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
	assertOutput(t, events, "shell.exec is not available.")
	assertToolFailure(t, events, "call_absent", "undefined_tool")
}
