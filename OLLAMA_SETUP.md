# Quick Setup Guide for Ollama

This guide will help you get Qwen Code working with Ollama in minutes.

## Step 1: Install Ollama

Visit [https://ollama.ai](https://ollama.ai) and install Ollama for your platform.

Verify installation:

```bash
ollama --version
```

## Step 2: Pull the Model

Pull the qwen3-coder model (or any other model you prefer):

```bash
# Recommended: qwen3-coder
ollama pull qwen3-coder

# Alternative models:
# ollama pull qwen2.5-coder
# ollama pull deepseek-coder
# ollama pull codellama
```

List available models:

```bash
ollama list
```

## Step 3: Verify Ollama is Running

```bash
# Check if Ollama service is running
curl http://localhost:11434/api/tags

# Test the model directly
ollama run qwen3-coder "Can you help me code?"
```

If you get connection errors, start Ollama:

- **Linux**: `systemctl start ollama` or `ollama serve`
- **macOS**: Ollama should start automatically, or run `ollama serve`
- **Windows**: Start Ollama from the Start menu or run `ollama serve`

## Step 4: Configure Qwen Code

### Option A: Environment Variables (Recommended)

Add to your `~/.bashrc`, `~/.zshrc`, or Windows environment variables:

```bash
export OPENAI_API_KEY="ollama"
export OPENAI_BASE_URL="http://localhost:11434/v1"
export OPENAI_MODEL="qwen3-coder"
```

Or create a `.env` file in your project (copy from `.env.example`):

```bash
cp .env.example .env
# Edit .env with your model name
```

### Option B: Settings File

Create `~/.qwen/settings.json`:

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
  }
}
```

### Option C: Command Line

```bash
qwen --openai-api-key "ollama" \
     --openai-base-url "http://localhost:11434/v1" \
     --model "qwen3-coder"
```

## Step 5: Test It!

```bash
# Start Qwen Code
qwen

# Try a simple command
> Explain what this codebase does
```

## Troubleshooting

### "Connection refused" Error

**Problem**: Ollama is not running or not accessible.

**Solution**:

```bash
# Check if Ollama is running
curl http://localhost:11434/api/tags

# If not running, start it:
ollama serve
# Or on Linux:
systemctl start ollama
```

### "Model not found" Error

**Problem**: The model name doesn't match what's in Ollama.

**Solution**:

```bash
# List your models
ollama list

# Use the exact model name (case-sensitive!)
# If you see "qwen3-coder", use "qwen3-coder" (not "Qwen3-Coder")
```

### Wrong Port

**Problem**: Ollama is running on a different port.

**Solution**: Update `OPENAI_BASE_URL`:

```bash
export OPENAI_BASE_URL="http://localhost:YOUR_PORT/v1"
```

### Remote Ollama Server

If Ollama is running on a remote server:

```bash
export OPENAI_BASE_URL="http://YOUR_SERVER_IP:11434/v1"
```

## Next Steps

- Read the full [OLLAMA_README.md](./OLLAMA_README.md) for advanced configuration
- Check out the [main README.md](./README.md) for usage examples
- Explore the [documentation](./docs/) for advanced features

## Common Model Names

Here are some popular coding models for Ollama:

- `qwen3-coder` - Qwen3-Coder (recommended)
- `qwen2.5-coder` - Qwen 2.5 Coder
- `deepseek-coder` - DeepSeek Coder
- `codellama` - Code Llama
- `mistral` - Mistral (general purpose, good for code)
- `llama3` - Llama 3 (general purpose)

Find more at: [https://ollama.com/library](https://ollama.com/library)
