# Timeout Analysis MCP Server

This Model-Context Protocol (MCP) server provides tools for analyzing and predicting streaming API timeouts based on mathematical modeling.

## Features

1. **Timeout Analysis**: Predicts whether a streaming request will timeout based on its characteristics
2. **Configuration Suggestions**: Recommends optimal timeout configuration based on historical data
3. **Adaptive Timeout Calculation**: Calculates adaptive timeouts based on request complexity

## Tools

### `analyze_streaming_timeout`

Analyzes a streaming request to predict if it will timeout and provides recommendations.

**Parameters:**

- `dataSize` (number): Data size in MB
- `complexity` (number): Request complexity (1-10 scale)
- `setupTime` (number): Expected setup time in seconds
- `processingRate` (number): Processing rate in MB/s
- `networkLatency` (number): Network latency in seconds per chunk
- `chunkSize` (number): Chunk size in MB

### `suggest_timeout_configuration`

Suggests optimal timeout configuration based on historical data.

**Parameters:**

- `historicalRequests` (array): Array of historical request data with the same structure as analyze_streaming_timeout parameters

## Usage

The server is automatically included in Qwen Code installations and will be available as an MCP tool.

To run the server manually:

```bash
cd packages/core
npm run start-timeout-server
```

## Integration

The server is automatically configured in the CLI and will be available to models when using Qwen Code.
