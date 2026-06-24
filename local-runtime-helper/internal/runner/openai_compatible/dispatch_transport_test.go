package openai_compatible

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/kmgrassi/local-runtime-helper/internal/runner"
)

func TestDispatchConstructsStreamingRequest(t *testing.T) {
	requests := make(chan chatRequest, 1)
	headers := make(chan http.Header, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Fatalf("path = %q, want /v1/chat/completions", r.URL.Path)
		}
		if r.Method != http.MethodPost {
			t.Fatalf("method = %q, want POST", r.Method)
		}
		var req chatRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		requests <- req
		headers <- r.Header.Clone()
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"hel\"}}]}\n\n"))
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"lo\"},\"finish_reason\":\"stop\"}]}\n\n"))
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}))
	defer server.Close()

	r, err := New(Config{Endpoint: server.URL + "/v1", APIKey: "ollama", Model: "qwen2.5-coder:latest"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	var events []any
	err = r.Dispatch(context.Background(), runner.ChatCompletionInput{
		Messages: []runner.ChatMessage{{Role: "user", Content: "hi"}},
	}, func(event any) error {
		events = append(events, event)
		return nil
	})
	if err != nil {
		t.Fatalf("Dispatch() error = %v", err)
	}

	req := <-requests
	if req.Model != "qwen2.5-coder:latest" {
		t.Fatalf("model = %q", req.Model)
	}
	if !req.Stream {
		t.Fatal("stream = false, want true")
	}
	if req.Messages[0].Content != "hi" {
		t.Fatalf("message content = %q", req.Messages[0].Content)
	}
	if got := (<-headers).Get("Authorization"); got != "Bearer ollama" {
		t.Fatalf("authorization = %q", got)
	}
	assertOutput(t, events, "hello")
}

func TestDispatchPassesAgentContextSystemMessageToProvider(t *testing.T) {
	requests := make(chan chatRequest, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req chatRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		requests <- req
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"done"},"finish_reason":"stop"}]}`))
	}))
	defer server.Close()

	r, err := New(Config{Endpoint: server.URL + "/v1", Model: "local-model"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	stream := false
	err = r.Dispatch(context.Background(), runner.ChatCompletionInput{
		Messages: []runner.ChatMessage{
			{Role: "system", Content: "Base prompt\n\nAgent instructions:\nAlways check the repo."},
			{Role: "user", Content: "list PRs"},
		},
		Stream: &stream,
	}, func(event any) error { return nil })
	if err != nil {
		t.Fatalf("Dispatch() error = %v", err)
	}

	req := <-requests
	if len(req.Messages) != 2 {
		t.Fatalf("messages = %#v, want two", req.Messages)
	}
	if req.Messages[0].Role != "system" || req.Messages[0].Content != "Base prompt\n\nAgent instructions:\nAlways check the repo." {
		t.Fatalf("system message = %#v", req.Messages[0])
	}
	if req.Messages[1].Role != "user" || req.Messages[1].Content != "list PRs" {
		t.Fatalf("user message = %#v", req.Messages[1])
	}
}

func TestDispatchSupportsNonStreamingFallback(t *testing.T) {
	attempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		var req chatRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if attempts == 1 {
			if !req.Stream {
				t.Fatal("first request stream = false, want true")
			}
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":{"message":"streaming is not supported","code":"unsupported_stream"}}`))
			return
		}
		if req.Stream {
			t.Fatal("fallback request stream = true, want false")
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"fallback text"},"finish_reason":"stop"}]}`))
	}))
	defer server.Close()

	r, err := New(Config{Endpoint: server.URL + "/v1", Model: "local-model"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	var events []any
	err = r.Dispatch(context.Background(), runner.ChatCompletionInput{
		Messages: []runner.ChatMessage{{Role: "user", Content: "hi"}},
	}, func(event any) error {
		events = append(events, event)
		return nil
	})
	if err != nil {
		t.Fatalf("Dispatch() error = %v", err)
	}
	if attempts != 2 {
		t.Fatalf("attempts = %d, want 2", attempts)
	}
	assertOutput(t, events, "fallback text")
}

func TestDispatchStripsMessageMetadataFromProviderRequest(t *testing.T) {
	requests := make(chan map[string]any, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req map[string]any
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		requests <- req
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"done"},"finish_reason":"stop"}]}`))
	}))
	defer server.Close()

	r, err := New(Config{Endpoint: server.URL + "/v1", Model: "local-model"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	stream := false
	err = r.Dispatch(context.Background(), runner.ChatCompletionInput{
		Messages: []runner.ChatMessage{{
			Role:    "user",
			Content: "scheduled instruction",
			Metadata: map[string]any{
				"source": "scheduled_task",
				"kind":   "scheduled_agent_message",
			},
		}},
		Stream: &stream,
	}, func(event any) error { return nil })
	if err != nil {
		t.Fatalf("Dispatch() error = %v", err)
	}

	req := <-requests
	messages, ok := req["messages"].([]any)
	if !ok || len(messages) != 1 {
		t.Fatalf("messages = %#v", req["messages"])
	}
	message, ok := messages[0].(map[string]any)
	if !ok {
		t.Fatalf("message = %#v", messages[0])
	}
	if _, exists := message["metadata"]; exists {
		t.Fatalf("provider message includes metadata: %#v", message)
	}
}

func TestDispatchNonStreamingByRequest(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req chatRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if req.Stream {
			t.Fatal("stream = true, want false")
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"plain"},"finish_reason":"stop"}]}`))
	}))
	defer server.Close()

	r, err := New(Config{Endpoint: server.URL + "/v1", Model: "local-model"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	stream := false
	var events []any
	err = r.Dispatch(context.Background(), runner.ChatCompletionInput{
		Messages: []runner.ChatMessage{{Role: "user", Content: "hi"}},
		Stream:   &stream,
	}, func(event any) error {
		events = append(events, event)
		return nil
	})
	if err != nil {
		t.Fatalf("Dispatch() error = %v", err)
	}
	assertOutput(t, events, "plain")
}

func TestDispatchMapsProviderErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":{"message":"model qwen2.5-coder:latest not found"}}`))
	}))
	defer server.Close()

	r, err := New(Config{Endpoint: server.URL + "/v1", Model: "qwen2.5-coder:latest"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	err = r.Dispatch(context.Background(), runner.ChatCompletionInput{
		Messages: []runner.ChatMessage{{Role: "user", Content: "hi"}},
	}, func(event any) error { return nil })
	if err == nil {
		t.Fatal("Dispatch() error = nil")
	}
	var runnerErr *runner.Error
	if !errors.As(err, &runnerErr) {
		t.Fatalf("error type = %T, want *runner.Error", err)
	}
	if runnerErr.Kind != runner.ErrorKindModelNotFound {
		t.Fatalf("kind = %q, want %q", runnerErr.Kind, runner.ErrorKindModelNotFound)
	}
	if runnerErr.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", runnerErr.StatusCode)
	}
}

func TestDispatchMapsContentFilterFinishReason(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"content_filter\"}]}\n\n"))
		_, _ = w.Write([]byte("data: [DONE]\n\n"))
	}))
	defer server.Close()

	r, err := New(Config{Endpoint: server.URL + "/v1", Model: "local-model"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	err = r.Dispatch(context.Background(), runner.ChatCompletionInput{
		Messages: []runner.ChatMessage{{Role: "user", Content: "hi"}},
	}, func(event any) error { return nil })
	if err == nil {
		t.Fatal("Dispatch() error = nil")
	}
	var runnerErr *runner.Error
	if !errors.As(err, &runnerErr) {
		t.Fatalf("error type = %T, want *runner.Error", err)
	}
	if runnerErr.Code != "provider_content_refused" {
		t.Fatalf("code = %q, want provider_content_refused", runnerErr.Code)
	}
}

func TestDispatchDoesNotMapPlainNotFoundToModelNotFound(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("not found"))
	}))
	defer server.Close()

	r, err := New(Config{Endpoint: server.URL + "/v1", Model: "local-model"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	err = r.Dispatch(context.Background(), runner.ChatCompletionInput{
		Messages: []runner.ChatMessage{{Role: "user", Content: "hi"}},
	}, func(event any) error { return nil })
	if err == nil {
		t.Fatal("Dispatch() error = nil")
	}
	var runnerErr *runner.Error
	if !errors.As(err, &runnerErr) {
		t.Fatalf("error type = %T, want *runner.Error", err)
	}
	if runnerErr.Kind != runner.ErrorKindProvider {
		t.Fatalf("kind = %q, want %q", runnerErr.Kind, runner.ErrorKindProvider)
	}
	if runnerErr.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", runnerErr.StatusCode)
	}
}

func TestDispatchRespectsCancellation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	defer server.Close()

	r, err := NewWithClient(Config{Endpoint: server.URL + "/v1", Model: "local-model"}, &http.Client{Timeout: time.Second})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err = r.Dispatch(ctx, runner.ChatCompletionInput{
		Messages: []runner.ChatMessage{{Role: "user", Content: "hi"}},
	}, func(event any) error { return nil })
	if err == nil {
		t.Fatal("Dispatch() error = nil")
	}
	var runnerErr *runner.Error
	if !errors.As(err, &runnerErr) {
		t.Fatalf("error type = %T, want *runner.Error", err)
	}
	if runnerErr.Kind != runner.ErrorKindCanceled {
		t.Fatalf("kind = %q, want %q", runnerErr.Kind, runner.ErrorKindCanceled)
	}
}

func TestDispatchMapsInFlightStreamCancellation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"first\"}}]}\n\n"))
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer server.Close()

	r, err := NewWithClient(Config{Endpoint: server.URL + "/v1", Model: "local-model"}, &http.Client{Timeout: time.Second})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	err = r.Dispatch(ctx, runner.ChatCompletionInput{
		Messages: []runner.ChatMessage{{Role: "user", Content: "hi"}},
	}, func(event any) error {
		if _, ok := event.(runner.OutputEvent); ok {
			cancel()
		}
		return nil
	})
	if err == nil {
		t.Fatal("Dispatch() error = nil")
	}
	var runnerErr *runner.Error
	if !errors.As(err, &runnerErr) {
		t.Fatalf("error type = %T, want *runner.Error", err)
	}
	if runnerErr.Kind != runner.ErrorKindCanceled {
		t.Fatalf("kind = %q, want %q", runnerErr.Kind, runner.ErrorKindCanceled)
	}
}

func TestListModelsParsesOpenAIModelsResponse(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path != "/v1/models" {
			t.Fatalf("path = %q, want /v1/models", req.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"qwen2.5-coder:7b"},{"id":"qwen3-coder:30b"}]}`))
	}))
	defer server.Close()

	r, err := New(Config{Endpoint: server.URL + "/v1", Model: "qwen2.5-coder:7b"})
	if err != nil {
		t.Fatalf("new runner: %v", err)
	}

	models, err := r.ListModels(context.Background())
	if err != nil {
		t.Fatalf("ListModels() error = %v", err)
	}
	if len(models) != 2 {
		t.Fatalf("models = %#v, want 2", models)
	}
	if models[0].ID != "qwen2.5-coder:7b" || models[1].ID != "qwen3-coder:30b" {
		t.Fatalf("models = %#v", models)
	}
	if models[0].Provider != "openai_compatible" {
		t.Fatalf("provider = %q, want openai_compatible", models[0].Provider)
	}
	if models[0].Capabilities["tool_calls"] != true {
		t.Fatalf("tool_calls capability = %#v, want true", models[0].Capabilities["tool_calls"])
	}
}
