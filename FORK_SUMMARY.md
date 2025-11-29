# Fork Summary: Qwen Code for Ollama

This document summarizes the changes made to create an Ollama-optimized fork of Qwen Code.

## Changes Made

### 1. Added Ollama Provider Support

**Files Modified:**

- `packages/core/src/core/openaiContentGenerator/provider/ollama.ts` (NEW)
- `packages/core/src/core/openaiContentGenerator/provider/index.ts`
- `packages/core/src/core/openaiContentGenerator/index.ts`
- `packages/core/src/core/openaiContentGenerator/constants.ts`

**What Changed:**

- Created `OllamaOpenAICompatibleProvider` class for Ollama-specific handling
- Added `DEFAULT_OLLAMA_BASE_URL` constant (`http://localhost:11434/v1`)
- Added automatic detection of Ollama URLs in provider selection
- Ollama provider uses standard OpenAI client with Ollama-specific defaults

### 2. Updated Package Metadata

**Files Modified:**

- `package.json`

**What Changed:**

- Package name: `@qwen-code/qwen-code` → `@qwen-code/qwen-code-ollama`
- Version: `0.3.0` → `0.3.0-ollama`

### 3. Documentation Updates

**Files Created:**

- `OLLAMA_README.md` - Comprehensive Ollama setup guide
- `OLLAMA_SETUP.md` - Quick setup guide
- `.env.example` - Example environment configuration
- `FORK_SUMMARY.md` - This file

**Files Modified:**

- `README.md` - Added Ollama fork notice and setup instructions

### 4. Telemetry Completely Removed

**Files Modified:**

- `packages/core/src/telemetry/sdk.ts` - `initializeTelemetry()` is now a no-op
- `packages/core/src/config/config.ts` - All telemetry getters return `false`
- `packages/core/src/telemetry/qwen-logger/qwen-logger.ts` - Always returns `undefined`
- `packages/core/src/telemetry/clearcut-logger/clearcut-logger.ts` - Always returns `undefined`

**What Changed:**

- `getTelemetryEnabled()` - Always returns `false` (hardcoded)
- `getUsageStatisticsEnabled()` - Always returns `false` (hardcoded)
- `initializeTelemetry()` - No-op function that does nothing
- `QwenLogger.getInstance()` - Always returns `undefined`
- `ClearcutLogger.getInstance()` - Always returns `undefined`
- Telemetry initialization removed from Config constructor

**Security Guarantee:**

- ✅ **No data can be transmitted** - All telemetry functions are disabled at the source
- ✅ **Configuration override protection** - Even if users try to enable via settings, it stays disabled
- ✅ **No network calls possible** - Loggers return undefined, preventing HTTP requests

See [TELEMETRY_REMOVAL.md](./TELEMETRY_REMOVAL.md) for detailed documentation.

### 5. Configuration Notes

**Web Search:**

- Disabled when no providers configured (default behavior)
- Users can optionally enable if they have internet access

**Default Behavior:**

- Telemetry: **Completely removed** (cannot be enabled) ✅
- Usage Statistics: **Completely removed** (cannot be enabled) ✅
- Web Search: Disabled when no providers configured ✅
- OAuth: Not used (local Ollama only) ✅

## How It Works

1. **Provider Detection**: When `baseUrl` contains `localhost:11434`, `127.0.0.1:11434`, or `ollama`, the Ollama provider is automatically selected.

2. **API Compatibility**: Ollama provides an OpenAI-compatible API, so the standard OpenAI client works with minimal modifications.

3. **Configuration**: Users configure via:
   - Environment variables (`OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`)
   - Settings file (`~/.qwen/settings.json`)
   - Command line arguments

## Usage

```bash
# Set environment variables
export OPENAI_API_KEY="ollama"
export OPENAI_BASE_URL="http://localhost:11434/v1"
export OPENAI_MODEL="qwen3-coder"

# Run Qwen Code
qwen
```

## Testing

To test the Ollama integration:

1. Ensure Ollama is running: `ollama serve`
2. Pull a model: `ollama pull qwen3-coder`
3. Configure environment variables (see above)
4. Run: `qwen`
5. Test with: `> Explain this codebase`

## Compatibility

- ✅ Fully compatible with original Qwen Code features
- ✅ Works with any OpenAI-compatible API (not just Ollama)
- ✅ All tools and features work identically
- ✅ No breaking changes to existing functionality

## Future Enhancements (Optional)

Potential improvements for the fork:

1. **Auto-detection**: Automatically detect if Ollama is running and configure defaults
2. **Model validation**: Check if the specified model exists in Ollama before starting
3. **Health checks**: Verify Ollama connectivity on startup
4. **Performance tuning**: Optimize timeouts/retries for local inference
5. **Batch processing**: Optimize for local model inference patterns

## Maintenance

This fork tracks the upstream Qwen Code repository. To sync updates while preserving your offline changes:

**Quick Start:**

```bash
# Add upstream remote (one time)
git remote add upstream https://github.com/QwenLM/qwen-code.git

# Regular sync
git fetch upstream
git merge upstream/main
# Resolve conflicts, keeping your telemetry removal and Ollama changes
```

**For detailed instructions**, see [MAINTAINING_FORK.md](./MAINTAINING_FORK.md) which covers:

- Step-by-step sync process
- Handling merge conflicts
- Protecting your telemetry removal
- Testing after sync
- Troubleshooting common issues

## License

Same as original: See [LICENSE](./LICENSE)
