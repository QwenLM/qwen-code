# Solution for Streaming API Timeout Issue (GitHub Issue #239)

## Problem Summary

The streaming API setup was timing out after 64 seconds, causing user frustration and
limiting the tool's effectiveness for large requests. The error message provided
generic troubleshooting tips but didn't offer specific solutions based on the request
characteristics.

## Solution Approach

We've implemented a comprehensive mathematical modeling approach to understand and solve
this timeout issue:

### 1. Mathematical Modeling

We created a model that calculates expected streaming request times based on:

- Data size and complexity
- System load factors
- Processing rates
- Network latency

This allows us to predict when timeouts will occur and recommend appropriate solutions.

### 2. Adaptive Timeout Calculation

Instead of fixed timeouts, we now calculate adaptive timeouts based on request
characteristics:

```javascript
Adaptive Timeout = Base Timeout +
                   (Data Size × 0.05) +
                   (Complexity × 0.1) +
                   (System Load × 20)
```

### 3. Enhanced Error Messaging

When timeouts occur, we now provide more specific troubleshooting guidance based on the
request characteristics:

- For large requests: Suggestions to break into smaller chunks
- For complex requests: Recommendations for progressive summarization
- Configuration suggestions: Current vs. recommended timeout values

### 4. CLI Configuration Options

New CLI options allow users to configure:

- `--openai-timeout`: Set API timeout in milliseconds
- `--openai-max-retries`: Set maximum retry attempts

### 5. Configuration Recommendations

The system now provides configuration recommendations based on analysis of current
settings, including:

- Optimal timeout values
- Sampling parameter adjustments
- Retry policy optimization

## Technical Implementation

### Core Changes

1. **Created StreamingTimeoutModel** - A mathematical model for predicting and
   preventing timeouts
2. **Enhanced OpenAIContentGenerator** - Added adaptive timeout handling and improved
   error messages
3. **Updated CLI Configuration** - Added new timeout and retry options
4. **Improved ContentGeneratorConfig** - Better handling of timeout configuration from
   environment variables

### Files Modified

- `packages/core/src/core/openaiContentGenerator.ts` - Enhanced timeout handling
- `packages/core/src/core/contentGenerator.ts` - Improved configuration handling
- `packages/cli/src/config/config.ts` - Added CLI options
- `packages/core/src/models/streamingTimeoutModel.ts` - New mathematical model
- `packages/core/src/models/streamingTimeoutModel.test.ts` - Tests for the model

## Usage Examples

### CLI Usage

```bash
# Increase timeout for large requests
qwen --openai-timeout 300000 --prompt "Analyze this large codebase"

# Set retry policy
qwen --openai-max-retries 5 --prompt "Complex analysis task"
```

### Configuration File

```json
{
  "contentGenerator": {
    "timeout": 120000,
    "maxRetries": 3,
    "samplingParams": {
      "temperature": 0.7,
      "max_tokens": 2048
    }
  }
}
```

## Testing

All tests pass, including new tests for the streaming timeout model:

- Unit tests for mathematical calculations
- Integration tests with the OpenAI content generator
- CLI configuration tests

## Future Improvements

1. **Machine Learning Approach**: Use historical data to predict optimal timeouts
2. **Dynamic Adjustment**: Real-time adjustment of timeouts based on
   current performance
3. **Progressive Enhancement**: Start with conservative timeouts and increase
   based on success patterns

This solution transforms a frustrating timeout issue into an opportunity for
intelligent, adaptive system behavior that improves the user experience for
large and complex requests.