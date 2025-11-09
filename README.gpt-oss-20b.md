# Qwen Code for GPT-OSS-20B Customization Guide

> This document provides analysis points and customization areas for adapting Qwen Code to work with GPT-OSS-20B model.

## Overview

GPT-OSS-20B is an open-source LLM that supports tool calling functionality, but its implementation differs from the current Gemini/OpenAI-based architecture in Qwen Code. This guide outlines the necessary internal customizations needed beyond simple API key and base URL changes.

## Key Differences & Customization Areas

### 1. Tool Calling Protocol Differences

**Current Implementation (Gemini/OpenAI):**
- File: `packages/core/src/core/openaiContentGenerator/streamingToolCallParser.ts`
- Tool calls are streamed with function name and arguments in specific format
- Uses `function` and `arguments` fields in tool_calls array

**GPT-OSS-20B Considerations:**
- May have different tool call format/structure
- Streaming behavior might differ
- Function argument parsing might require custom logic
- Analyze actual API responses to understand exact format

**Files to Customize:**
- `packages/core/src/core/openaiContentGenerator/streamingToolCallParser.ts` - Tool call parsing logic
- `packages/core/src/core/openaiContentGenerator/converter.ts` - Response conversion from API format
- `packages/core/src/core/openaiContentGenerator/pipeline.ts` - Request/response pipeline

### 2. API Request Format

**Current Implementation:**
- File: `packages/core/src/core/geminiChat.ts` (lines for API calls)
- Uses Gemini SDK and OpenAI SDK for requests
- Specific message formatting and system prompt structure

**GPT-OSS-20B Considerations:**
- Check exact request format required (message structure, parameters)
- Validate system prompt compatibility
- Check support for tool definitions in request body
- Verify parameter naming (temperature, max_tokens, etc.)

**Files to Customize:**
- `packages/core/src/core/openaiContentGenerator/pipeline.ts` - Request builder
- `packages/core/src/config/models.ts` - Model constants and effective model selection
- `packages/core/src/core/prompts.ts` - System prompts (may need adjustment)

### 3. Tool Definition Format

**Current Implementation:**
- File: `packages/core/src/tools/tools.ts` (Tool interface definition)
- File: `packages/core/src/core/openaiContentGenerator/converter.ts` (Tool schema conversion)
- Uses JSON schema format for tool definitions

**GPT-OSS-20B Considerations:**
- Verify if tool schema format matches GPT-OSS-20B expectations
- Check if any tool parameters need different descriptions
- Validate function naming conventions
- Test required vs optional parameters handling

**Files to Customize:**
- `packages/core/src/core/openaiContentGenerator/converter.ts` - Tool schema builder
- `packages/core/src/tools/tool-registry.ts` - Tool registration and schema export

### 4. Response Parsing & Tool Call Extraction

**Current Implementation:**
- File: `packages/core/src/core/openaiContentGenerator/streamingToolCallParser.ts` (14.4 KB)
- Handles streaming responses and extracts tool calls
- Parses finish_reason: "tool_calls" behavior

**GPT-OSS-20B Considerations:**
- Different finish_reason values?
- Different tool_calls structure in response?
- Different error/edge case handling needed?
- May require custom state machine for parsing

**Files to Analyze & Customize:**
- `packages/core/src/core/openaiContentGenerator/streamingToolCallParser.ts` - Complete rewrite likely needed
- `packages/core/src/core/openaiContentGenerator/converter.ts` - Response object conversion

### 5. Token Limit & Cost Calculation

**Current Implementation:**
- File: `packages/core/src/core/tokenLimits.ts`
- Different limits for different model tiers
- Cost per token calculations

**GPT-OSS-20B Considerations:**
- Get exact context window size
- Check if token counting differs from OpenAI's approach
- May not need cost calculation (open-source)
- May need custom tokenizer or use different counting method

**Files to Customize:**
- `packages/core/src/core/tokenLimits.ts` - Token limit constants
- `packages/core/src/utils/request-tokenizer/` - Tokenization logic

### 6. Error Handling & Fallback Logic

**Current Implementation:**
- File: `packages/core/src/config/flashFallback.ts` - Fallback to different model tier
- File: `packages/core/src/utils/retry.ts` - Exponential backoff retry logic
- File: `packages/core/src/utils/quotaErrorDetection.ts` - Quota error detection

**GPT-OSS-20B Considerations:**
- Different error codes/messages from API
- May not have quota limits (open-source)
- Fallback strategy (to different model version or reduced features?)
- Custom error detection needed for GPT-OSS-20B errors

**Files to Customize:**
- `packages/core/src/utils/quotaErrorDetection.ts` - Error pattern matching
- `packages/core/src/config/flashFallback.ts` - Fallback logic (may be simplified)
- `packages/core/src/core/client.ts` - Error handling in main client

### 7. Prompt Engineering & System Messages

**Current Implementation:**
- File: `packages/core/src/core/prompts.ts` (45.2 KB) - Large system prompt
- File: `packages/core/src/qwen/qwenContentGenerator.ts` - Qwen-specific prompt adjustments
- Different prompts for different scenarios

**GPT-OSS-20B Considerations:**
- System prompt may need optimization for GPT-OSS-20B capabilities
- Tool calling instructions might need rephrasing
- Few-shot examples may need adjustment
- Consider prompt length vs context window trade-offs

**Files to Review & Customize:**
- `packages/core/src/core/prompts.ts` - Main system prompt refinement
- Create `packages/core/src/core/gptoss20bPrompts.ts` (new file) - Custom prompts for GPT-OSS-20B
- `packages/core/src/core/openaiContentGenerator/pipeline.ts` - Prompt injection points

### 8. Streaming & Real-time Response Handling

**Current Implementation:**
- File: `packages/core/src/core/openaiContentGenerator/streamingToolCallParser.ts` - Streaming parser
- File: `packages/core/src/core/geminiChat.ts` - Chat streaming logic
- Handles streaming JSON parsing and tool call detection

**GPT-OSS-20B Considerations:**
- Verify streaming response format
- Check if streaming is supported at all
- Different state transitions for streaming?
- May need custom buffering/parsing logic

**Files to Customize:**
- `packages/core/src/core/openaiContentGenerator/streamingToolCallParser.ts`
- `packages/core/src/core/openaiContentGenerator/pipeline.ts` - Stream handling

## Implementation Path

### Phase 1: Analysis & Configuration
1. **Test GPT-OSS-20B API directly** to understand:
   - Exact request/response format
   - Tool calling behavior
   - Error responses
   - Streaming format (if supported)

2. **Create configuration layer:**
   - Add GPT-OSS-20B to `packages/core/src/config/models.ts`
   - Define token limits
   - Set API base URL and model names

### Phase 2: Core Customizations (High Priority)
1. **Tool call parsing** - Most critical for tool calling functionality
   - Customize `streamingToolCallParser.ts`
   - Update `converter.ts` for response parsing

2. **Request/Response pipeline** - Adapt to API format
   - Modify `pipeline.ts` for request building
   - Ensure tool schema matches GPT-OSS-20B format

3. **Error handling** - Graceful degradation
   - Update error detection patterns
   - Adjust fallback logic

### Phase 3: Optimizations (Medium Priority)
1. **Prompt engineering** - Improve tool calling reliability
   - Create `gptoss20bPrompts.ts` with optimized prompts
   - Test and refine instructions

2. **Token management** - Optimize context usage
   - Adjust prompt verbosity if needed
   - Optimize tool schema descriptions

### Phase 4: Advanced Features (Low Priority)
1. **Streaming optimization** - If supported
2. **Multi-turn conversation improvements**
3. **Tool calling reliability enhancements**

## Files Summary by Priority

### CRITICAL (Core Tool Calling)
- `packages/core/src/core/openaiContentGenerator/streamingToolCallParser.ts` - Parse tool calls from responses
- `packages/core/src/core/openaiContentGenerator/converter.ts` - Convert API responses and build tool schemas
- `packages/core/src/core/openaiContentGenerator/pipeline.ts` - Build requests and handle responses

### HIGH (API Integration)
- `packages/core/src/config/models.ts` - Add GPT-OSS-20B model definition
- `packages/core/src/core/client.ts` - Main client initialization and error handling
- `packages/core/src/utils/quotaErrorDetection.ts` - Error pattern detection

### MEDIUM (Optimization)
- `packages/core/src/core/prompts.ts` - System prompt tuning
- `packages/core/src/core/tokenLimits.ts` - Token limit configuration
- Create: `packages/core/src/core/gptoss20bPrompts.ts` - GPT-OSS-20B specific prompts

### LOW (Enhancement)
- `packages/core/src/config/flashFallback.ts` - Fallback strategy (may not be needed)
- `packages/core/src/utils/retry.ts` - Retry logic refinement

## Testing Checklist

- [ ] Tool calling works (function name and args correctly extracted)
- [ ] Multi-turn conversations maintain context
- [ ] Error handling doesn't crash the application
- [ ] Token counting is accurate
- [ ] Streaming responses parse correctly
- [ ] Tool schema descriptions are appropriate
- [ ] System prompt is suitable for GPT-OSS-20B
- [ ] Performance is acceptable for typical use cases

## Additional Notes

- Keep customizations isolated (use feature flags or separate classes where possible)
- Document any GPT-OSS-20B specific behaviors
- Consider creating a `GptOss20bContentGenerator` class extending `ContentGenerator` for clean separation
- Test with actual GPT-OSS-20B API responses before finalizing
- Monitor token usage patterns to ensure efficient context utilization
