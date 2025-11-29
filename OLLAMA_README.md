# Qwen Code - Ollama Fork

This is a fork of [Qwen Code](https://github.com/QwenLM/qwen-code) specifically configured for **Ollama** and **offline/air-gapped environments**.

## 🎯 Purpose

This fork enables you to:

- Use **qwen3-coder** (or any other model) running locally via **Ollama**
- Work completely **offline** without internet connectivity
- Operate in **air-gapped environments** with no external API calls
- Maintain all the powerful code understanding and editing capabilities of Qwen Code

## 🚀 Quick Start

### Prerequisites

1. **Install Ollama**: [https://ollama.ai](https://ollama.ai)
2. **Pull qwen3-coder model**:

   ```bash
   ollama pull qwen3-coder
   ```

   Or use any other model you prefer:

   ```bash
   ollama pull qwen2.5-coder
   ollama pull deepseek-coder
   ```

3. **Install Node.js 20+**: [https://nodejs.org](https://nodejs.org)

### Installation

```bash
# Clone this fork
git clone <your-fork-url>
cd qwen-code

# Install dependencies
npm install

# Build the project
npm run build

# Install globally
npm install -g .
```

### Configuration

#### Method 1: Environment Variables (Recommended for Ollama)

```bash
export OPENAI_API_KEY="ollama"  # Ollama doesn't require a real key, but the field is required
export OPENAI_BASE_URL="http://localhost:11434/v1"
export OPENAI_MODEL="qwen3-coder"  # Must match the model name in Ollama
```

#### Method 2: Settings File

Create or edit `~/.qwen/settings.json`:

```json
{
  "security": {
    "auth": {
      "selectedType": "openai",
      "apiKey": "ollama",
      "baseUrl": "http://localhost:11434/v1"
    }
  },
  "model": {
    "generationConfig": {
      "model": "qwen3-coder"
    }
  },
  "telemetry": {
    "enabled": false
  },
  "webSearch": null
}
```

#### Method 3: Command Line

```bash
qwen --openai-api-key "ollama" \
     --openai-base-url "http://localhost:11434/v1" \
     --model "qwen3-coder"
```

## 🔧 Offline/Air-Gapped Configuration

This fork is pre-configured for offline use:

### ✅ Disabled by Default

- **Telemetry**: No data sent to external services
- **Web Search**: Disabled (requires internet)
- **OAuth**: Not used (local Ollama only)

### 📝 Recommended Settings for Air-Gapped Environments

Add to `~/.qwen/settings.json`:

```json
{
  "telemetry": {
    "enabled": false
  },
  "webSearch": null,
  "model": {
    "generationConfig": {
      "model": "qwen3-coder",
      "temperature": 0.1,
      "maxTokens": 8192
    }
  }
}
```

## 🎮 Usage

Once configured, use it just like the original Qwen Code:

```bash
# Start the CLI
qwen

# Example commands
> Explain this codebase structure
> Help me refactor this function
> Generate unit tests for this module
```

## 🔍 Verifying Ollama Connection

Test that Ollama is working:

```bash
# Check if Ollama is running
curl http://localhost:11434/api/tags

# Test the model directly
ollama run qwen3-coder "Hello, can you code?"
```

## 🐛 Troubleshooting

### Model Not Found

If you get errors about the model not being found:

```bash
# List available models
ollama list

# Pull the model if missing
ollama pull qwen3-coder
```

### Connection Refused

If you see connection errors:

1. **Check Ollama is running**:

   ```bash
   # On Linux/Mac
   systemctl status ollama

   # Or check if the service is running
   curl http://localhost:11434/api/tags
   ```

2. **Verify the base URL** matches your Ollama setup:
   - Default: `http://localhost:11434/v1`
   - Custom port: `http://localhost:YOUR_PORT/v1`
   - Remote server: `http://YOUR_SERVER:11434/v1`

### Model Name Mismatch

The `OPENAI_MODEL` or `--model` value must **exactly match** the Ollama model name:

```bash
# Check your model name
ollama list

# Use the exact name (case-sensitive)
export OPENAI_MODEL="qwen3-coder"  # ✅ Correct
export OPENAI_MODEL="Qwen3-Coder"  # ❌ Wrong (case mismatch)
```

## 🔄 Differences from Original

### What Changed

1. **Default Configuration**: Pre-configured for Ollama
2. **Telemetry**: Disabled by default
3. **Web Search**: Disabled by default
4. **Documentation**: Updated for Ollama/offline use

### What Stayed the Same

- All core functionality (code understanding, editing, tools)
- File system operations
- Git integration
- MCP server support
- Extension system
- All other features work identically

## 📦 Building for Distribution

If you want to distribute this fork:

```bash
# Build all packages
npm run build:all

# Create a package
npm pack
```

## 🤝 Contributing

This is a fork focused on Ollama/offline support. If you want to contribute:

1. Fork this repository
2. Make your changes
3. Test with Ollama
4. Submit a pull request

## 📄 License

Same as the original project: See [LICENSE](./LICENSE)

## 🙏 Acknowledgments

- Original [Qwen Code](https://github.com/QwenLM/qwen-code) project
- [Ollama](https://ollama.ai) for local LLM inference
- [Qwen3-Coder](https://github.com/QwenLM/Qwen3-Coder) model

## 🔗 Related Links

- [Ollama Documentation](https://github.com/ollama/ollama)
- [Qwen3-Coder Model](https://github.com/QwenLM/Qwen3-Coder)
- [Original Qwen Code](https://github.com/QwenLM/qwen-code)
