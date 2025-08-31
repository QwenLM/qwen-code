# Streaming API Timeout Modeling and Solutions

This document explains the mathematical modeling approach used to understand and solve the streaming API timeout issue described in GitHub issue #239.

## Problem Analysis

The issue occurs when streaming API requests timeout after 64 seconds during setup. This is a systems-level problem that can be modeled mathematically to understand the contributing factors and design appropriate solutions.

## Mathematical Model

We model the total time for a streaming request as:

```
Total Time = Setup Time + Processing Time + Network Overhead

Where:
- Setup Time = Base Setup Time × (1 + System Load Factor)
- Processing Time = Data Size / Processing Rate
- Network Overhead = Chunks × Network Latency Per Chunk
- Chunks = Data Size / Chunk Size
```

## Key Variables

1. **Data Size**: The size of the input data in MB
2. **System Load**: Current load on the system (0-1 scale)
3. **Processing Rate**: How fast the system can process data (MB/s)
4. **Network Latency**: Latency per chunk in seconds
5. **Chunk Size**: Size of data chunks in MB

## Solutions Implemented

### 1. Adaptive Timeout Calculation

Instead of a fixed timeout, we calculate timeouts based on request characteristics:

```
Adaptive Timeout = Base Timeout +
                   (Data Size × 0.05) +
                   (Complexity × 0.1) +
                   (System Load × 20)
```

### 2. Enhanced Error Messaging

When timeouts occur, we provide more specific troubleshooting guidance based on the request characteristics.

### 3. CLI Configuration Options

New CLI options allow users to configure:

- `--openai-timeout`: Set API timeout in milliseconds
- `--openai-max-retries`: Set maximum retry attempts

### 4. Configuration Recommendations

The system now provides configuration recommendations based on analysis of current settings.

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

## Future Improvements

1. **Machine Learning Approach**: Use historical data to predict optimal timeouts
2. **Dynamic Adjustment**: Real-time adjustment of timeouts based on current performance
3. **Progressive Enhancement**: Start with conservative timeouts and increase based on success patterns
