package openai_compatible

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"

	"github.com/kmgrassi/local-runtime-helper/internal/runner"
)

const defaultMaxToolIterations = 10

func translateToolDefinitions(definitions []runner.ToolDefinition) []runner.ToolSpec {
	tools := make([]runner.ToolSpec, 0, len(definitions))
	for _, definition := range definitions {
		tools = append(tools, runner.ToolSpec{
			Type: "function",
			Function: runner.ToolFunction{
				Name:        definition.Name,
				Description: definition.Description,
				Parameters:  definition.ParametersSchema,
			},
		})
	}
	return tools
}

func (r *Runner) dispatchWithTools(ctx context.Context, input runner.ChatCompletionInput, emit func(event any) error) error {
	if input.ToolCallingMode == "helper_managed" && r.toolExecutor == nil {
		return &runner.Error{Kind: runner.ErrorKindInvalidInput, Message: "helper-managed tool calling requires a tool executor"}
	}

	maxIterations := defaultMaxToolIterations
	if input.ToolCallingConfig != nil && input.ToolCallingConfig.MaxIterations > 0 {
		maxIterations = input.ToolCallingConfig.MaxIterations
	}

	messages := append([]runner.ChatMessage(nil), input.Messages...)
	definitionsByName := toolDefinitionsByName(input.ToolDefinitions, input.ProviderToolSpecs)

	usePromptFallback := false
	for i := 0; i < maxIterations; i++ {
		next := input
		next.Messages = messages
		if usePromptFallback {
			next.ProviderToolSpecs = nil
			next.Messages = prependToolSystemMessage(messages, input.ToolDefinitions)
		}

		response, err := r.complete(ctx, next)
		if err != nil {
			if !usePromptFallback && shouldFallbackToPromptTools(err) {
				usePromptFallback = true
				next = input
				next.Messages = prependToolSystemMessage(messages, input.ToolDefinitions)
				next.ProviderToolSpecs = nil
				response, err = r.complete(ctx, next)
			}
			if err != nil {
				return err
			}
		}

		toolCalls := response.ToolCalls
		parsedPromptToolCalls := false
		if len(toolCalls) == 0 {
			toolCalls = parsePromptToolCalls(response.Content)
			parsedPromptToolCalls = len(toolCalls) > 0
		}
		if len(toolCalls) == 0 {
			if response.Content != "" {
				if err := emit(runner.OutputEvent{Kind: "output", Text: response.Content}); err != nil {
					return &runner.Error{Kind: runner.ErrorKindEmitFailed, Message: err.Error()}
				}
			}
			if err := emit(runner.CompleteEvent{Kind: "complete", FinishReason: response.FinishReason}); err != nil {
				return &runner.Error{Kind: runner.ErrorKindEmitFailed, Message: err.Error()}
			}
			return nil
		}
		if response.Content != "" && !parsedPromptToolCalls {
			if err := emit(runner.OutputEvent{Kind: "output", Text: response.Content}); err != nil {
				return &runner.Error{Kind: runner.ErrorKindEmitFailed, Message: err.Error()}
			}
		}

		messages = append(messages, runner.ChatMessage{
			Role:      "assistant",
			Content:   response.Content,
			ToolCalls: toolCalls,
		})
		validatedCalls, validationFailures := validateToolCalls(toolCalls, definitionsByName)
		if len(validationFailures) > 0 {
			for _, failure := range validationFailures {
				if err := emit(runner.ToolExecutionEvent{
					Kind:       "tool.completed",
					ToolCallID: failure.result.ToolCallID,
					Name:       failure.name,
					Result:     &failure.result,
				}); err != nil {
					return &runner.Error{Kind: runner.ErrorKindEmitFailed, Message: err.Error()}
				}
				resultJSON, _ := json.Marshal(failure.result)
				messages = append(messages, runner.ChatMessage{
					Role:       "tool",
					Content:    string(resultJSON),
					ToolCallID: failure.result.ToolCallID,
				})
			}
			continue
		}

		var runtimeToolCalls []runner.ToolCall
		for _, validated := range validatedCalls {
			call := validated.call
			args := validated.arguments
			definition := validated.definition
			if input.ToolCallingMode != "helper_managed" || definition.ExecutionKind != "helper" {
				runtimeToolCalls = append(runtimeToolCalls, runner.ToolCall{
					ID:              call.ID,
					Name:            definition.Name,
					Arguments:       args,
					GrantProvenance: definition.GrantProvenance,
				})
				continue
			}
			if err := emit(runner.ToolExecutionEvent{
				Kind:            "tool.started",
				ToolCallID:      call.ID,
				Name:            definition.Name,
				Arguments:       args,
				GrantProvenance: definition.GrantProvenance,
			}); err != nil {
				return &runner.Error{Kind: runner.ErrorKindEmitFailed, Message: err.Error()}
			}

			result := r.executeHelperTool(ctx, runner.ToolCallRequest{
				ToolCallID: call.ID,
				Name:       definition.Name,
				Arguments:  args,
				Definition: &definition,
			})
			if err := emit(runner.ToolExecutionEvent{
				Kind:            "tool.completed",
				ToolCallID:      call.ID,
				Name:            definition.Name,
				GrantProvenance: definition.GrantProvenance,
				Result:          &result,
			}); err != nil {
				return &runner.Error{Kind: runner.ErrorKindEmitFailed, Message: err.Error()}
			}

			resultJSON, _ := json.Marshal(result)
			messages = append(messages, runner.ChatMessage{
				Role:       "tool",
				Content:    string(resultJSON),
				ToolCallID: call.ID,
			})
		}
		if len(runtimeToolCalls) > 0 {
			if err := emit(runner.ToolCallRequestEvent{
				Kind:      "tool_call_request",
				ToolCalls: runtimeToolCalls,
			}); err != nil {
				return &runner.Error{Kind: runner.ErrorKindEmitFailed, Message: err.Error()}
			}
			return nil
		}
	}

	message := fmt.Sprintf("I could not finish because the local tool-calling loop exceeded its limit of %d iterations.", maxIterations)
	if err := emit(runner.OutputEvent{Kind: "output", Text: message}); err != nil {
		return &runner.Error{Kind: runner.ErrorKindEmitFailed, Message: err.Error()}
	}
	if err := emit(runner.CompleteEvent{Kind: "complete", FinishReason: "tool_iterations_exceeded"}); err != nil {
		return &runner.Error{Kind: runner.ErrorKindEmitFailed, Message: err.Error()}
	}
	return nil
}

type validatedToolCall struct {
	call       runner.ProviderToolCall
	arguments  map[string]any
	definition runner.ToolDefinition
}

type toolValidationFailure struct {
	name   string
	result runner.ToolCallResult
}

func validateToolCalls(calls []runner.ProviderToolCall, definitionsByName map[string]runner.ToolDefinition) ([]validatedToolCall, []toolValidationFailure) {
	validated := make([]validatedToolCall, 0, len(calls))
	failures := make([]toolValidationFailure, 0)
	for _, call := range calls {
		args, err := decodeToolArguments(call.Function.Arguments)
		if err != nil {
			failures = append(failures, toolValidationFailure{
				name: call.Function.Name,
				result: toolCallErrorResult(
					call.ID,
					call.Function.Name,
					"invalid_arguments",
					err.Error(),
				),
			})
			continue
		}
		definition, ok := definitionsByName[call.Function.Name]
		if !ok {
			failures = append(failures, toolValidationFailure{
				name: call.Function.Name,
				result: toolCallErrorResult(
					call.ID,
					call.Function.Name,
					"undefined_tool",
					fmt.Sprintf("tool %q is not defined", call.Function.Name),
				),
			})
			continue
		}
		validated = append(validated, validatedToolCall{
			call:       call,
			arguments:  args,
			definition: definition,
		})
	}
	if len(failures) > 0 {
		for _, call := range validated {
			failures = append(failures, toolValidationFailure{
				name: call.call.Function.Name,
				result: toolCallErrorResult(
					call.call.ID,
					call.call.Function.Name,
					"tool_batch_invalid",
					"tool call was not executed because another tool call in the same model response was invalid",
				),
			})
		}
		return nil, failures
	}
	return validated, nil
}

func (r *Runner) executeHelperTool(ctx context.Context, req runner.ToolCallRequest) (result runner.ToolCallResult) {
	defer func() {
		if recovered := recover(); recovered != nil {
			result = toolCallErrorResult(req.ToolCallID, req.Name, "tool_panic", fmt.Sprintf("local tool execution panicked: %v", recovered))
		}
	}()
	return r.toolExecutor.Execute(ctx, req)
}

func toolCallErrorResult(toolCallID, name, code, message string) runner.ToolCallResult {
	return runner.ToolCallResult{
		ToolCallID: toolCallID,
		Success:    false,
		Output: map[string]any{
			"ok":           false,
			"error":        code,
			"message":      message,
			"tool":         name,
			"tool_call_id": toolCallID,
		},
	}
}

type toolCompletion struct {
	Content      string
	ToolCalls    []runner.ProviderToolCall
	FinishReason string
}

func (r *Runner) complete(ctx context.Context, input runner.ChatCompletionInput) (toolCompletion, error) {
	resp, err := r.doChat(ctx, input, false)
	if err != nil {
		return toolCompletion{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return toolCompletion{}, parseProviderError(resp)
	}

	body, logResponse := r.rawModelResponseBody(input, false, resp.Body)
	defer logResponse()

	var response completionResponse
	if err := json.NewDecoder(body).Decode(&response); err != nil {
		return toolCompletion{}, &runner.Error{Kind: runner.ErrorKindProvider, Message: fmt.Sprintf("openai_compatible response is invalid JSON: %v", err)}
	}
	if len(response.Choices) == 0 {
		return toolCompletion{}, &runner.Error{Kind: runner.ErrorKindProvider, Message: "openai_compatible response did not include choices"}
	}
	choice := response.Choices[0]
	return toolCompletion{
		Content:      choice.Message.Content,
		ToolCalls:    choice.Message.ToolCalls,
		FinishReason: choice.FinishReason,
	}, nil
}

func shouldFallbackToPromptTools(err error) bool {
	var runnerErr *runner.Error
	if !errors.As(err, &runnerErr) {
		return false
	}
	if runnerErr.StatusCode == http.StatusBadRequest {
		return true
	}
	if runnerErr.StatusCode != http.StatusUnprocessableEntity && runnerErr.StatusCode != http.StatusInternalServerError {
		return false
	}
	text := normalizeProviderErrorText(runnerErr.Message + " " + runnerErr.Code)
	if runnerErr.StatusCode == http.StatusUnprocessableEntity {
		return mentionsToolProtocol(text)
	}
	return mentionsToolProtocol(text) || isOllamaNativeToolTemplateError(text)
}

func normalizeProviderErrorText(value string) string {
	text := strings.ToLower(value)
	text = strings.ReplaceAll(text, `\u003c`, "<")
	text = strings.ReplaceAll(text, `\u003e`, ">")
	return text
}

func mentionsToolProtocol(value string) bool {
	return strings.Contains(value, "tools") || strings.Contains(value, "functions") || strings.Contains(value, "tool_choice")
}

func isOllamaNativeToolTemplateError(value string) bool {
	return strings.Contains(value, "xml syntax error") &&
		(strings.Contains(value, "<parameter>") || strings.Contains(value, "parameter")) &&
		(strings.Contains(value, "<function>") || strings.Contains(value, "function"))
}

func prependToolSystemMessage(messages []runner.ChatMessage, definitions []runner.ToolDefinition) []runner.ChatMessage {
	var b strings.Builder
	b.WriteString("You may call tools by replying with JSON in this shape: ")
	b.WriteString(`{"tool_call":{"name":"tool_name","arguments":{}}}`)
	b.WriteString(". Available tools: ")
	for i, definition := range definitions {
		if i > 0 {
			b.WriteString("; ")
		}
		b.WriteString(definition.Name)
		if definition.Description != "" {
			b.WriteString(": ")
			b.WriteString(definition.Description)
		}
	}
	out := make([]runner.ChatMessage, 0, len(messages)+1)
	out = append(out, runner.ChatMessage{Role: "system", Content: b.String()})
	out = append(out, messages...)
	return out
}

func parsePromptToolCalls(content string) []runner.ProviderToolCall {
	if calls := parseJSONPromptToolCalls(content); len(calls) > 0 {
		return calls
	}
	return parseTaggedPromptToolCalls(content)
}

func parseJSONPromptToolCalls(content string) []runner.ProviderToolCall {
	var envelope struct {
		ToolCall struct {
			ID        string         `json:"id"`
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		} `json:"tool_call"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(content)), &envelope); err != nil {
		return nil
	}
	if envelope.ToolCall.Name == "" {
		return nil
	}
	args, _ := json.Marshal(envelope.ToolCall.Arguments)
	id := envelope.ToolCall.ID
	if id == "" {
		id = "prompt_tool_call"
	}
	return []runner.ProviderToolCall{{
		ID:   id,
		Type: "function",
		Function: runner.ToolCallFunc{
			Name:      envelope.ToolCall.Name,
			Arguments: string(args),
		},
	}}
}

var (
	providerToolNameUnsafeRE = regexp.MustCompile(`[^a-zA-Z0-9_-]`)
	taggedFunctionRE         = regexp.MustCompile(`(?s)<function=([A-Za-z0-9_.-]+)>\s*(.*?)\s*</function>`)
	taggedParameterRE        = regexp.MustCompile(`(?s)<parameter=([A-Za-z0-9_.-]+)>\s*(.*?)\s*</parameter>`)
)

func safeProviderToolName(toolName string) string {
	name := providerToolNameUnsafeRE.ReplaceAllString(toolName, "_")
	if len(name) > 64 {
		return name[:64]
	}
	return name
}

func parseTaggedPromptToolCalls(content string) []runner.ProviderToolCall {
	matches := taggedFunctionRE.FindAllStringSubmatch(strings.TrimSpace(content), -1)
	if len(matches) == 0 {
		return nil
	}

	calls := make([]runner.ProviderToolCall, 0, len(matches))
	for index, match := range matches {
		if len(match) != 3 {
			continue
		}
		name := strings.TrimSpace(match[1])
		if name == "" {
			continue
		}
		args := map[string]any{}
		for _, param := range taggedParameterRE.FindAllStringSubmatch(match[2], -1) {
			if len(param) != 3 {
				continue
			}
			key := strings.TrimSpace(param[1])
			if key == "" {
				continue
			}
			args[key] = parseTaggedParameterValue(param[2])
		}
		argsJSON, _ := json.Marshal(args)
		calls = append(calls, runner.ProviderToolCall{
			ID:   fmt.Sprintf("prompt_tool_call_%d", index+1),
			Type: "function",
			Function: runner.ToolCallFunc{
				Name:      name,
				Arguments: string(argsJSON),
			},
		})
	}
	return calls
}

func parseTaggedParameterValue(raw string) any {
	value := strings.TrimSpace(raw)
	var decoded any
	if err := json.Unmarshal([]byte(value), &decoded); err == nil {
		return decoded
	}
	switch strings.ToLower(value) {
	case "true":
		return true
	case "false":
		return false
	case "null":
		return nil
	default:
		return value
	}
}

func toolDefinitionsByName(definitions []runner.ToolDefinition, providerSpecs []runner.ToolSpec) map[string]runner.ToolDefinition {
	definitionsByName := make(map[string]runner.ToolDefinition, len(definitions))
	expectedProviderNames := providerToolNames(definitions)

	for index, definition := range definitions {
		definitionsByName[definition.Name] = definition
		if index < len(providerSpecs) {
			providerName := providerSpecs[index].Function.Name
			if providerName != "" && index < len(expectedProviderNames) && providerName == expectedProviderNames[index] {
				definitionsByName[providerName] = definition
			}
		}
	}
	return definitionsByName
}

func providerToolNames(definitions []runner.ToolDefinition) []string {
	names := make([]string, 0, len(definitions))
	seen := map[string]bool{}

	for _, definition := range definitions {
		baseName := safeProviderToolName(definition.Name)
		providerName := baseName
		for index := 0; seen[providerName]; index++ {
			providerName = fmt.Sprintf("%s_%d", baseName, index+1)
		}
		seen[providerName] = true
		names = append(names, providerName)
	}

	return names
}

func canonicalToolCalls(providerCalls []runner.ProviderToolCall, definitionsByName map[string]runner.ToolDefinition) ([]runner.ToolCall, error) {
	calls := make([]runner.ToolCall, 0, len(providerCalls))
	for _, providerCall := range providerCalls {
		definition, ok := definitionsByName[providerCall.Function.Name]
		if !ok {
			return nil, &runner.Error{Kind: runner.ErrorKindInvalidInput, Message: fmt.Sprintf("tool %q is not defined", providerCall.Function.Name)}
		}
		args, err := decodeToolArguments(providerCall.Function.Arguments)
		if err != nil {
			return nil, err
		}
		calls = append(calls, runner.ToolCall{
			ID:        providerCall.ID,
			Name:      definition.Name,
			Arguments: args,
		})
	}
	return calls, nil
}

func decodeToolArguments(raw string) (map[string]any, error) {
	if strings.TrimSpace(raw) == "" {
		return map[string]any{}, nil
	}
	var args map[string]any
	if err := json.Unmarshal([]byte(raw), &args); err != nil {
		return nil, &runner.Error{Kind: runner.ErrorKindInvalidInput, Message: fmt.Sprintf("tool call arguments are invalid JSON: %v", err)}
	}
	return args, nil
}
