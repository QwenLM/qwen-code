# GPT-OSS-20B Environment Configuration Guide

**Date**: 2025-11-09
**Purpose**: Configure Qwen Code to work with GPT-OSS-20B

## Overview

GPT-OSS-20B is a locally-hosted model that may have different performance characteristics than cloud-based APIs. This guide provides configuration for optimal integration with Qwen Code.

## ⚠️ CRITICAL: API Key Security

**NEVER hardcode API keys in source code!**

Always use environment variables for sensitive credentials:

```bash
# ✅ CORRECT - Use environment variables
export OPENAI_API_KEY="your_api_key_here"

# ❌ WRONG - Never hardcode in code
const API_KEY = "17fe7b3588c3af5afe4344d474be0336177d37952c370c6012ab671c828a264e";
```

## Basic Configuration

### Required Environment Variables

```bash
# API Endpoint
export OPENAI_BASE_URL="https://ryzen.parrot-mine.ts.net"

# API Authentication
export OPENAI_API_KEY="your_api_key_here"

# Model Identifier
export OPENAI_MODEL="openai/gpt-4o"
```

### Using .env File (Recommended)

Create a `.env` file in your project root:

```env
# GPT-OSS-20B Configuration
OPENAI_BASE_URL=https://ryzen.parrot-mine.ts.net
OPENAI_API_KEY=your_api_key_here
OPENAI_MODEL=openai/gpt-4o
```

**Security Note**: Add `.env` to `.gitignore` to prevent accidental commits:

```bash
echo ".env" >> .gitignore
```

## Performance Configuration

### Timeout Settings (Important for Low-End GPUs)

GPT-OSS-20B running on lower-end hardware requires increased timeouts:

**Default timeout**: 120 seconds (may be insufficient)

**Recommended timeout for GPT-OSS-20B**: 300-600 seconds

#### Option 1: Environment Variable

```bash
# Increase timeout to 5 minutes (300 seconds)
export OPENAI_TIMEOUT=300000

# For very slow GPUs, use 10 minutes (600 seconds)
export OPENAI_TIMEOUT=600000
```

#### Option 2: Configuration File

Create `.qwen/settings.json` in your project root:

```json
{
  "timeout": 300000,
  "maxRetries": 3
}
```

### Performance Observations from Testing

Based on API testing with GPT-OSS-20B:

| Query Type   | Avg Response Time | Tokens/Second |
| ------------ | ----------------- | ------------- |
| Simple math  | ~800ms            | 60 tokens/s   |
| Tool calling | ~620ms            | 60 tokens/s   |
| Streaming    | ~830ms            | 60 tokens/s   |

**Note**: Complex queries or long responses may take significantly longer.

### Retry Configuration

For unstable connections or slow responses:

```bash
# Increase retry attempts
export OPENAI_MAX_RETRIES=5

# Or in settings.json
{
  "maxRetries": 5
}
```

## Complete Configuration Example

### Production Setup (.env file)

```env
# ========================================
# GPT-OSS-20B Configuration
# ========================================

# API Endpoint (required)
OPENAI_BASE_URL=https://ryzen.parrot-mine.ts.net

# API Key (required) - NEVER commit this file!
OPENAI_API_KEY=your_actual_api_key_here

# Model (required)
OPENAI_MODEL=openai/gpt-4o

# Performance Tuning (optional)
# Timeout in milliseconds (5 minutes for slow GPUs)
OPENAI_TIMEOUT=300000

# Max retry attempts
OPENAI_MAX_RETRIES=3

# ========================================
# Qwen Code Settings (optional)
# ========================================

# Session token limit (128K for GPT-OSS-20B)
SESSION_TOKEN_LIMIT=131072

# Enable debug logging
DEBUG=false
```

### Development/Testing Setup

```bash
#!/bin/bash
# setup-gpt-oss.sh - Development environment setup

export OPENAI_BASE_URL="https://ryzen.parrot-mine.ts.net"
export OPENAI_API_KEY="your_dev_api_key"
export OPENAI_MODEL="openai/gpt-4o"
export OPENAI_TIMEOUT=600000  # 10 minutes for testing
export DEBUG=true             # Enable debug logs

# Source this file before running qwen
# Usage: source setup-gpt-oss.sh && qwen
```

## Troubleshooting

### Timeout Errors

**Symptom**:

```
Error: Request timeout after 120s
```

**Solution**:

1. Increase timeout: `export OPENAI_TIMEOUT=600000`
2. Reduce input length or complexity
3. Check GPU utilization on the server
4. Use streaming mode for long responses

### Connection Errors

**Symptom**:

```
Error: Connection refused or network error
```

**Solution**:

1. Verify server is running: `curl https://ryzen.parrot-mine.ts.net/v1/models`
2. Check API key is correct
3. Verify network connectivity
4. Check firewall/proxy settings

### Slow Response Times

**Expected for Low-End GPUs:**

- Simple queries: 1-5 seconds
- Complex queries: 5-30 seconds
- Long responses: 30-120 seconds

**If slower than expected:**

1. Check GPU utilization on server
2. Reduce concurrent requests
3. Increase server GPU resources
4. Consider model quantization (if not already applied)

### Out of Memory Errors

**Symptom**:

```
Error: CUDA out of memory
```

**This is a server-side issue. Solutions:**

1. Reduce context window size: `SESSION_TOKEN_LIMIT=65536`
2. Use smaller batch size on server
3. Reduce max_tokens in requests
4. Restart server to clear memory leaks

## Performance Optimization Tips

### 1. Use Streaming Mode

Streaming provides faster time-to-first-token:

```bash
qwen --stream
```

### 2. Reduce Token Limits

Limit output length to improve response time:

```json
{
  "maxTokens": 2048
}
```

### 3. Enable Token Caching

GPT-OSS-20B supports prompt caching:

```json
{
  "cache_n": 64 // Cache last 64 tokens
}
```

### 4. Batch Similar Requests

Group related queries to leverage context caching:

```bash
qwen "First question about the codebase"
qwen "Related follow-up question"
```

## Monitoring and Debugging

### Enable Detailed Logging

```bash
export DEBUG=true
export OPENAI_LOG_LEVEL=debug
```

### Monitor API Performance

Create a test script:

```bash
#!/bin/bash
# test-api-performance.sh

echo "Testing GPT-OSS-20B API..."
time curl -X POST https://ryzen.parrot-mine.ts.net/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -d '{
    "model": "openai/gpt-4o",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 10
  }'
```

### Check Server Metrics

If you have access to the GPT-OSS-20B server:

```bash
# GPU utilization
nvidia-smi

# Memory usage
watch -n 1 nvidia-smi

# Server logs
tail -f /path/to/server/logs/gpt-oss.log
```

## Integration with Qwen Code

### Start Qwen Code with GPT-OSS-20B

```bash
# Load environment
source .env

# Start Qwen Code
qwen

# Or specify inline
OPENAI_MODEL=openai/gpt-4o qwen
```

### Verify Configuration

```bash
qwen --model openai/gpt-4o
> /stats
# Should show:
# - Model: openai/gpt-4o
# - Token limit: 128K
# - Timeout: 300s (or your setting)
```

### Switch Between Models

```bash
# Use GPT-OSS-20B
export OPENAI_MODEL=openai/gpt-4o
qwen

# Use Qwen-Coder
unset OPENAI_MODEL  # Falls back to default
qwen
```

## Security Checklist

- [ ] API key stored in environment variable or .env file
- [ ] .env file added to .gitignore
- [ ] No API keys in source code
- [ ] API key has appropriate permissions
- [ ] Using HTTPS endpoint
- [ ] API key rotated regularly
- [ ] Secrets not logged or printed

## FAQ

### Q: Can I use GPT-OSS-20B and Qwen-Coder simultaneously?

**A**: Yes! Just switch the `OPENAI_MODEL` environment variable:

```bash
# Use GPT-OSS-20B
export OPENAI_MODEL=openai/gpt-4o
qwen

# Use Qwen-Coder
export OPENAI_MODEL=coder-model
qwen
```

### Q: How do I know which model is being used?

**A**: Check with `/stats` command or look for `reasoning_content` in responses (GPT-OSS-20B only).

### Q: What if my GPU is very slow?

**A**: Increase timeout to 10-15 minutes:

```bash
export OPENAI_TIMEOUT=900000  # 15 minutes
```

### Q: Does Qwen Code cache responses?

**A**: The model may cache prompts, but Qwen Code doesn't cache responses locally. Check server-side caching settings.

## Next Steps

1. ✅ Set up environment variables
2. ✅ Test basic connectivity
3. ⏳ Adjust timeout for your GPU performance
4. ⏳ Configure `.qwen/settings.json` for project-specific settings
5. ⏳ Set up monitoring and logging
6. ⏳ Test with actual use cases

## Additional Resources

- [Qwen Code Documentation](../docs/)
- [OpenAI API Compatibility](https://platform.openai.com/docs/api-reference)
- [GPT-OSS Project](https://github.com/gpt-oss)
- [Performance Tuning Guide](./05-performance-tuning.md) (coming soon)
