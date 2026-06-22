// Package openai_compatible implements a runner adapter for local servers that
// expose the OpenAI chat-completions API surface.
package openai_compatible

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/kmgrassi/local-runtime-helper/internal/runner"
)

const Kind = "openai_compatible"

// rawModelIOEnvVar gates verbose logging of the exact request and response
// bodies exchanged with the local model. It mirrors the orchestrator's
// OPENMACAW_LOG_MODEL_CONTEXT_RAW flag so a single env var turns on full
// model-I/O logging across both subsystems. Off by default: these dumps write
// full prompts, tool arguments, and tool results in plaintext.
const rawModelIOEnvVar = "OPENMACAW_LOG_MODEL_CONTEXT_RAW"

// Config controls a single OpenAI-compatible local endpoint.
type Config struct {
	Endpoint     string
	APIKey       string
	Model        string
	Timeout      time.Duration
	ToolExecutor ToolExecutor
	// Logger receives diagnostic logs, including the raw model request/response
	// bodies when rawModelIOEnvVar is set. Defaults to a no-op logger.
	Logger *slog.Logger
}

func rawModelIOLoggingEnabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(rawModelIOEnvVar))) {
	case "1", "true", "yes":
		return true
	default:
		return false
	}
}

// ToolExecutor executes helper-managed tool calls. The concrete filesystem,
// shell, and git executor lands in the tool executor PR; this runner only
// depends on the narrow call/result contract.
type ToolExecutor interface {
	Execute(context.Context, runner.ToolCallRequest) runner.ToolCallResult
}

// Runner dispatches chat-completion requests to an OpenAI-compatible endpoint.
type Runner struct {
	cfg          Config
	client       *http.Client
	toolExecutor ToolExecutor
}

// New returns a runner using the default HTTP client.
func New(cfg Config) (*Runner, error) {
	return NewWithClient(cfg, nil)
}

// NewWithClient returns a runner using client. It exists for tests and future
// relay wiring that wants shared transport settings.
func NewWithClient(cfg Config, client *http.Client) (*Runner, error) {
	if strings.TrimSpace(cfg.Endpoint) == "" {
		return nil, &runner.Error{Kind: runner.ErrorKindInvalidInput, Message: "openai_compatible endpoint is required"}
	}
	if strings.TrimSpace(cfg.Model) == "" {
		return nil, &runner.Error{Kind: runner.ErrorKindInvalidInput, Message: "openai_compatible model is required"}
	}
	if _, err := url.ParseRequestURI(cfg.Endpoint); err != nil {
		return nil, &runner.Error{Kind: runner.ErrorKindInvalidInput, Message: fmt.Sprintf("openai_compatible endpoint is invalid: %v", err)}
	}
	if client == nil {
		client = &http.Client{}
	}
	if cfg.Timeout > 0 {
		copyClient := *client
		copyClient.Timeout = cfg.Timeout
		client = &copyClient
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	return &Runner{cfg: cfg, client: client, toolExecutor: cfg.ToolExecutor}, nil
}

func (r *Runner) Kind() string {
	return Kind
}

// ListModels returns the endpoint's current OpenAI-compatible /models list.
func (r *Runner) ListModels(ctx context.Context) ([]runner.ModelInfo, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, modelsURL(r.cfg.Endpoint), nil)
	if err != nil {
		return nil, &runner.Error{Kind: runner.ErrorKindInvalidInput, Message: fmt.Sprintf("openai_compatible models request could not be created: %v", err)}
	}
	if r.cfg.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+r.cfg.APIKey)
	}

	resp, err := r.client.Do(req)
	if err != nil {
		return nil, normalizeHTTPError(ctx, err, modelsURL(r.cfg.Endpoint))
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, parseProviderError(resp)
	}

	var body struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
		Models []struct {
			Name string `json:"name"`
		} `json:"models"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, &runner.Error{
			Kind:    runner.ErrorKindProvider,
			Message: fmt.Sprintf("openai_compatible models response is invalid JSON: %v", err),
			Detail:  runner.ErrorDetail{Endpoint: modelsURL(r.cfg.Endpoint), RawMessage: err.Error()},
		}
	}

	seen := map[string]struct{}{}
	models := make([]runner.ModelInfo, 0, len(body.Data)+len(body.Models))
	for _, item := range body.Data {
		if item.ID == "" {
			continue
		}
		if _, ok := seen[item.ID]; ok {
			continue
		}
		seen[item.ID] = struct{}{}
		models = append(models, modelInfo(item.ID))
	}
	for _, item := range body.Models {
		if item.Name == "" {
			continue
		}
		if _, ok := seen[item.Name]; ok {
			continue
		}
		seen[item.Name] = struct{}{}
		models = append(models, modelInfo(item.Name))
	}
	sort.Slice(models, func(i, j int) bool { return models[i].ID < models[j].ID })
	return models, nil
}

func modelInfo(id string) runner.ModelInfo {
	return runner.ModelInfo{
		ID:       id,
		Provider: "openai_compatible",
		Capabilities: map[string]any{
			"runtime_managed_tools": true,
			"streaming":             true,
			"tool_calls":            true,
		},
	}
}

func (r *Runner) Dispatch(ctx context.Context, input any, emit func(event any) error) error {
	req, err := normalizeInput(input)
	if err != nil {
		return err
	}
	if len(req.Messages) == 0 {
		return &runner.Error{Kind: runner.ErrorKindInvalidInput, Message: "openai_compatible dispatch requires at least one message"}
	}
	if req.Model == "" {
		req.Model = r.cfg.Model
	}
	if req.ProviderToolSpecs == nil && len(req.ToolDefinitions) > 0 {
		req.ProviderToolSpecs = translateToolDefinitions(req.ToolDefinitions)
	}
	if len(req.ProviderToolSpecs) > 0 && (req.ToolCallingMode == "helper_managed" || req.ToolCallingMode == "runtime_managed") {
		return r.dispatchWithTools(ctx, req, emit)
	}
	stream := true
	if req.Stream != nil {
		stream = *req.Stream
	}

	if stream {
		err = r.chat(ctx, req, true, emit)
		if err == nil {
			return nil
		}
		if !shouldRetryWithoutStream(err) {
			return err
		}
	}
	return r.chat(ctx, req, false, emit)
}

func normalizeInput(input any) (runner.ChatCompletionInput, error) {
	switch v := input.(type) {
	case runner.ChatCompletionInput:
		return v, nil
	case *runner.ChatCompletionInput:
		if v == nil {
			return runner.ChatCompletionInput{}, &runner.Error{Kind: runner.ErrorKindInvalidInput, Message: "openai_compatible dispatch input is nil"}
		}
		return *v, nil
	case []byte:
		return decodeInput(v)
	case json.RawMessage:
		return decodeInput(v)
	case map[string]any:
		data, err := json.Marshal(v)
		if err != nil {
			return runner.ChatCompletionInput{}, &runner.Error{Kind: runner.ErrorKindInvalidInput, Message: fmt.Sprintf("openai_compatible dispatch input could not be encoded: %v", err)}
		}
		return decodeInput(data)
	default:
		return runner.ChatCompletionInput{}, &runner.Error{Kind: runner.ErrorKindInvalidInput, Message: fmt.Sprintf("unsupported openai_compatible dispatch input %T", input)}
	}
}

func decodeInput(data []byte) (runner.ChatCompletionInput, error) {
	var req runner.ChatCompletionInput
	if err := json.Unmarshal(data, &req); err != nil {
		return req, &runner.Error{Kind: runner.ErrorKindInvalidInput, Message: fmt.Sprintf("openai_compatible dispatch input is invalid JSON: %v", err)}
	}
	return req, nil
}

func (r *Runner) chat(ctx context.Context, input runner.ChatCompletionInput, stream bool, emit func(event any) error) error {
	resp, err := r.doChat(ctx, input, stream)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	definitionsByName := toolDefinitionsByName(input.ToolDefinitions, input.ProviderToolSpecs)

	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return parseProviderError(resp)
	}

	body, logResponse := r.rawModelResponseBody(input, stream, resp.Body)
	defer logResponse()

	if stream {
		if !isEventStream(resp.Header.Get("Content-Type")) {
			return parseCompletion(body, definitionsByName, emit)
		}
		return parseStream(ctx, body, definitionsByName, emit)
	}
	return parseCompletion(body, definitionsByName, emit)
}

func (r *Runner) rawModelResponseBody(input runner.ChatCompletionInput, stream bool, body io.Reader) (io.Reader, func()) {
	if !rawModelIOLoggingEnabled() {
		return body, func() {}
	}

	var captured bytes.Buffer
	return io.TeeReader(body, &captured), func() {
		r.cfg.Logger.Info("local model response",
			"model", input.Model,
			"stream", stream,
			"body", captured.String(),
		)
	}
}

func (r *Runner) doChat(ctx context.Context, input runner.ChatCompletionInput, stream bool) (*http.Response, error) {
	body, err := json.Marshal(chatRequest{
		Model:       input.Model,
		Messages:    providerMessages(input.Messages),
		Temperature: input.Temperature,
		MaxTokens:   input.MaxTokens,
		Stream:      stream,
		Tools:       input.ProviderToolSpecs,
	})
	if err != nil {
		return nil, &runner.Error{Kind: runner.ErrorKindInvalidInput, Message: fmt.Sprintf("openai_compatible request could not be encoded: %v", err)}
	}

	// Log the exact request body (system + agent context, message history, and
	// tool definitions) when raw model-I/O logging is enabled.
	if rawModelIOLoggingEnabled() {
		r.cfg.Logger.Info("local model request",
			"endpoint", chatCompletionsURL(r.cfg.Endpoint),
			"model", input.Model,
			"stream", stream,
			"body", string(body),
		)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, chatCompletionsURL(r.cfg.Endpoint), bytes.NewReader(body))
	if err != nil {
		return nil, &runner.Error{Kind: runner.ErrorKindInvalidInput, Message: fmt.Sprintf("openai_compatible request could not be created: %v", err)}
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if r.cfg.APIKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+r.cfg.APIKey)
	}

	resp, err := r.client.Do(httpReq)
	if err != nil {
		return nil, normalizeHTTPError(ctx, err, chatCompletionsURL(r.cfg.Endpoint))
	}
	return resp, nil
}

func modelsURL(endpoint string) string {
	trimmed := strings.TrimRight(endpoint, "/")
	if strings.HasSuffix(trimmed, "/models") {
		return trimmed
	}
	return trimmed + "/models"
}

func chatCompletionsURL(endpoint string) string {
	trimmed := strings.TrimRight(endpoint, "/")
	if strings.HasSuffix(trimmed, "/chat/completions") {
		return trimmed
	}
	return trimmed + "/chat/completions"
}

func providerMessages(messages []runner.ChatMessage) []providerChatMessage {
	providerMessages := make([]providerChatMessage, 0, len(messages))
	for _, message := range messages {
		providerMessages = append(providerMessages, providerChatMessage{
			Role:       message.Role,
			Content:    message.Content,
			ToolCalls:  message.ToolCalls,
			ToolCallID: message.ToolCallID,
		})
	}
	return providerMessages
}

func isEventStream(contentType string) bool {
	return strings.Contains(strings.ToLower(contentType), "text/event-stream")
}

func normalizeHTTPError(ctx context.Context, err error, endpoint string) error {
	if ctx.Err() != nil {
		return &runner.Error{Kind: runner.ErrorKindCanceled, Message: ctx.Err().Error()}
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return &runner.Error{
			Kind:    runner.ErrorKindEndpointUnavailable,
			Message: "openai_compatible endpoint timed out",
			Hint:    "Check that the local model server is running and reachable.",
			Detail:  runner.ErrorDetail{Endpoint: endpoint, DialError: err.Error()},
		}
	}
	var opErr *net.OpError
	if errors.As(err, &opErr) {
		return &runner.Error{
			Kind:    runner.ErrorKindEndpointUnavailable,
			Message: "openai_compatible endpoint is unavailable",
			Hint:    "Check that the local model server is running and reachable.",
			Detail:  runner.ErrorDetail{Endpoint: endpoint, DialError: err.Error()},
		}
	}
	return &runner.Error{Kind: runner.ErrorKindProvider, Message: err.Error(), Detail: runner.ErrorDetail{Endpoint: endpoint, RawMessage: err.Error()}}
}

type chatRequest struct {
	Model       string                `json:"model"`
	Messages    []providerChatMessage `json:"messages"`
	Temperature *float64              `json:"temperature,omitempty"`
	MaxTokens   *int                  `json:"max_tokens,omitempty"`
	Stream      bool                  `json:"stream"`
	Tools       []runner.ToolSpec     `json:"tools,omitempty"`
}

type providerChatMessage struct {
	Role       string                    `json:"role"`
	Content    string                    `json:"content"`
	ToolCalls  []runner.ProviderToolCall `json:"tool_calls,omitempty"`
	ToolCallID string                    `json:"tool_call_id,omitempty"`
}

type errorEnvelope struct {
	Error providerError `json:"error"`
}

type providerError struct {
	Message string `json:"message"`
	Type    string `json:"type"`
	Code    string `json:"code"`
}

func parseProviderError(resp *http.Response) error {
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	rawMessage := strings.TrimSpace(string(data))
	status := resp.StatusCode
	detail := runner.ErrorDetail{
		HTTPStatus: &status,
		Endpoint:   resp.Request.URL.String(),
		RawMessage: rawMessage,
	}
	var envelope errorEnvelope
	if err := json.Unmarshal(data, &envelope); err == nil && envelope.Error.Message != "" {
		kind := runner.ErrorKindProvider
		code := envelope.Error.Code
		msg := envelope.Error.Message
		if isModelNotFound(code, msg) {
			kind = runner.ErrorKindModelNotFound
		}
		return &runner.Error{
			Kind:       kind,
			Message:    msg,
			StatusCode: resp.StatusCode,
			Code:       code,
			Detail:     detail,
		}
	}
	msg := rawMessage
	if msg == "" {
		msg = resp.Status
	}
	kind := runner.ErrorKindProvider
	if isModelNotFound("", msg) {
		kind = runner.ErrorKindModelNotFound
	}
	return &runner.Error{Kind: kind, Message: msg, StatusCode: resp.StatusCode, Detail: detail}
}

func isModelNotFound(code, msg string) bool {
	text := strings.ToLower(code + " " + msg)
	return strings.Contains(text, "model_not_found") ||
		strings.Contains(text, "model not found") ||
		(strings.Contains(text, "model ") && strings.Contains(text, " not found"))
}

func shouldRetryWithoutStream(err error) bool {
	var runnerErr *runner.Error
	if !errors.As(err, &runnerErr) {
		return false
	}
	if runnerErr.StatusCode != http.StatusBadRequest && runnerErr.StatusCode != http.StatusUnprocessableEntity {
		return false
	}
	text := strings.ToLower(runnerErr.Message + " " + runnerErr.Code)
	return strings.Contains(text, "stream") || strings.Contains(text, "streaming")
}

type streamChunk struct {
	Choices []struct {
		Delta struct {
			Content   string           `json:"content"`
			ToolCalls []streamToolCall `json:"tool_calls,omitempty"`
		} `json:"delta"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
}

type streamToolCall struct {
	Index    int    `json:"index"`
	ID       string `json:"id,omitempty"`
	Type     string `json:"type,omitempty"`
	Function struct {
		Name      string `json:"name,omitempty"`
		Arguments string `json:"arguments,omitempty"`
	} `json:"function"`
}

func parseStream(ctx context.Context, body io.Reader, definitionsByName map[string]runner.ToolDefinition, emit func(event any) error) error {
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	index := 0
	finishReason := ""
	toolCalls := map[int]*runner.ProviderToolCall{}
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, ":") {
			continue
		}
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "[DONE]" {
			break
		}
		var chunk streamChunk
		if err := json.Unmarshal([]byte(payload), &chunk); err != nil {
			return &runner.Error{Kind: runner.ErrorKindProvider, Message: fmt.Sprintf("openai_compatible stream chunk is invalid JSON: %v", err)}
		}
		for _, choice := range chunk.Choices {
			if choice.FinishReason != "" {
				finishReason = choice.FinishReason
			}
			for _, tc := range choice.Delta.ToolCalls {
				call := toolCalls[tc.Index]
				if call == nil {
					call = &runner.ProviderToolCall{}
					toolCalls[tc.Index] = call
				}
				if tc.ID != "" {
					call.ID = tc.ID
				}
				if tc.Type != "" {
					call.Type = tc.Type
				}
				if tc.Function.Name != "" {
					call.Function.Name = tc.Function.Name
				}
				call.Function.Arguments += tc.Function.Arguments
			}
			if choice.Delta.Content == "" {
				continue
			}
			if err := emit(runner.OutputEvent{Kind: "output", Text: choice.Delta.Content, Index: index}); err != nil {
				return &runner.Error{Kind: runner.ErrorKindEmitFailed, Message: err.Error()}
			}
			index++
		}
	}
	if ctx.Err() != nil {
		return &runner.Error{Kind: runner.ErrorKindCanceled, Message: ctx.Err().Error()}
	}
	if err := scanner.Err(); err != nil {
		if ctx.Err() != nil {
			return &runner.Error{Kind: runner.ErrorKindCanceled, Message: ctx.Err().Error()}
		}
		return &runner.Error{Kind: runner.ErrorKindProvider, Message: fmt.Sprintf("openai_compatible stream read failed: %v", err)}
	}
	if len(toolCalls) > 0 {
		calls, err := canonicalToolCalls(sortedStreamToolCalls(toolCalls), definitionsByName)
		if err != nil {
			return err
		}
		if err := emit(runner.ToolCallRequestEvent{Kind: "tool_call_request", ToolCalls: calls}); err != nil {
			return &runner.Error{Kind: runner.ErrorKindEmitFailed, Message: err.Error()}
		}
		return nil
	}
	if isContentRefusalFinishReason(finishReason) {
		return &runner.Error{
			Kind:    runner.ErrorKindProvider,
			Message: "openai_compatible provider refused the request due to content policy",
			Code:    "provider_content_refused",
		}
	}
	if err := emit(runner.CompleteEvent{Kind: "complete", FinishReason: finishReason}); err != nil {
		return &runner.Error{Kind: runner.ErrorKindEmitFailed, Message: err.Error()}
	}
	return nil
}

func sortedStreamToolCalls(toolCalls map[int]*runner.ProviderToolCall) []runner.ProviderToolCall {
	indexes := make([]int, 0, len(toolCalls))
	for index := range toolCalls {
		indexes = append(indexes, index)
	}
	sort.Ints(indexes)

	calls := make([]runner.ProviderToolCall, 0, len(indexes))
	for _, index := range indexes {
		if call := toolCalls[index]; call != nil {
			calls = append(calls, *call)
		}
	}
	return calls
}

type completionResponse struct {
	Choices []struct {
		Message struct {
			Content   string                    `json:"content"`
			ToolCalls []runner.ProviderToolCall `json:"tool_calls,omitempty"`
		} `json:"message"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
}

func parseCompletion(body io.Reader, definitionsByName map[string]runner.ToolDefinition, emit func(event any) error) error {
	var response completionResponse
	if err := json.NewDecoder(body).Decode(&response); err != nil {
		return &runner.Error{Kind: runner.ErrorKindProvider, Message: fmt.Sprintf("openai_compatible response is invalid JSON: %v", err)}
	}
	finishReason := ""
	var providerToolCalls []runner.ProviderToolCall
	for index, choice := range response.Choices {
		if choice.FinishReason != "" {
			finishReason = choice.FinishReason
		}
		if len(choice.Message.ToolCalls) > 0 {
			providerToolCalls = append(providerToolCalls, choice.Message.ToolCalls...)
			continue
		}
		if choice.Message.Content == "" {
			continue
		}
		if err := emit(runner.OutputEvent{Kind: "output", Text: choice.Message.Content, Index: index}); err != nil {
			return &runner.Error{Kind: runner.ErrorKindEmitFailed, Message: err.Error()}
		}
	}
	if len(providerToolCalls) > 0 {
		toolCalls, err := canonicalToolCalls(providerToolCalls, definitionsByName)
		if err != nil {
			return err
		}
		if err := emit(runner.ToolCallRequestEvent{Kind: "tool_call_request", ToolCalls: toolCalls}); err != nil {
			return &runner.Error{Kind: runner.ErrorKindEmitFailed, Message: err.Error()}
		}
		return nil
	}
	if isContentRefusalFinishReason(finishReason) {
		return &runner.Error{
			Kind:    runner.ErrorKindProvider,
			Message: "openai_compatible provider refused the request due to content policy",
			Code:    "provider_content_refused",
		}
	}
	if err := emit(runner.CompleteEvent{Kind: "complete", FinishReason: finishReason}); err != nil {
		return &runner.Error{Kind: runner.ErrorKindEmitFailed, Message: err.Error()}
	}
	return nil
}

func isContentRefusalFinishReason(finishReason string) bool {
	return strings.EqualFold(strings.TrimSpace(finishReason), "content_filter")
}
