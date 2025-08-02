# OpenAI Authentication

Qwen Code CLI supports OpenAI authentication for users who want to use OpenAI models instead of Google's Gemini models.

## Authentication Methods

### 1. Interactive Authentication (Recommended)

When you first run the CLI and select OpenAI as your authentication method, you'll be prompted to enter:

- **API Key**: Your OpenAI API key from [https://platform.openai.com/api-keys](https://platform.openai.com/api-keys)
- **Base URL**: The base URL for OpenAI API (defaults to `https://api.openai.com/v1`)
- **Model**: The OpenAI model to use (defaults to `gpt-4o`)

The CLI will guide you through each field:

1. Enter your API key and press Enter
2. Review/modify the base URL and press Enter
3. Review/modify the model name and press Enter

**Note**: You can paste your API key directly - the CLI supports paste functionality and will display the full key for verification.

### 2. Command Line Arguments

You can also provide the OpenAI credentials via command line arguments:

```bash
# Basic usage with API key
qwen-code --openai-api-key "your-api-key-here"

# With custom base URL
qwen-code --openai-api-key "your-api-key-here" --openai-base-url "https://your-custom-endpoint.com/v1"

# With custom model
qwen-code --openai-api-key "your-api-key-here" --model "gpt-4-turbo"
```

### 3. Environment Variables

Set the following environment variables in your shell or `.env` file:

```bash
export QWEN_CODE_API_KEY="your-api-key-here"
export QWEN_CODE_BASE_URL="https://api.openai.com/v1"  # Optional, defaults to this value
export QWEN_CODE_MODEL="gpt-4o"  # Optional, defaults to gpt-4o
```

## Supported Models

The CLI supports all OpenAI models that are available through the OpenAI API, including:

- `gpt-4o` (default)
- `gpt-4o-mini`
- `gpt-4-turbo`
- `gpt-4`
- `gpt-3.5-turbo`
- And other available models

## Custom Endpoints

You can use custom endpoints by setting the `QWEN_CODE_BASE_URL` environment variable or using the `--openai-base-url` command line argument. This is useful for:

- Using Azure OpenAI
- Using other OpenAI-compatible APIs
- Using local OpenAI-compatible servers

## Switching Authentication Methods

To switch between authentication methods, use the `/auth` command in the CLI interface.

## Security Notes

- API keys are stored in memory during the session
- For persistent storage, use environment variables or `.env` files
- Never commit API keys to version control
- The CLI displays API keys in plain text for verification - ensure your terminal is secure
