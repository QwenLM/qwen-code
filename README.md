# Qwen Code

![Qwen Code Screenshot](./docs/assets/qwen-screenshot.png)

Qwen Code is a command-line AI workflow tool adapted from [**Gemini CLI**](https://github.com/google-gemini/gemini-cli) (Please refer to [this document](./README.gemini.md) for more details), optimized for [Qwen3-Coder](https://github.com/QwenLM/Qwen3-Coder) models with enhanced parser support & tool support.

> [!WARNING]
> Qwen Code may issue multiple API calls per cycle, resulting in higher token usage, similar to Claude Code. We’re actively working to enhance API efficiency and improve the overall developer experience. ModelScope offers 2,000 free API calls if you are in China mainland. Please check [API config section](#api-configuration) for more details.

## Key Features

- **Code Understanding & Editing** - Query and edit large codebases beyond traditional context window limits
- **Workflow Automation** - Automate operational tasks like handling pull requests and complex rebases
- **Enhanced Parser** - Adapted parser specifically optimized for Qwen-Coder models

## Quick Start

### Prerequisites

Ensure you have [Node.js version 20](https://nodejs.org/en/download) or higher installed.

```bash
curl -qL https://www.npmjs.com/install.sh | sh
```

### Installation

```bash
npm install -g @qwen-code/qwen-code@latest
qwen --version
```

Then run from anywhere:

```bash
qwen
```

Or you can install it from source:

```bash
git clone https://github.com/QwenLM/qwen-code.git
cd qwen-code
npm install
npm install -g .
```

We now support max session token limit, you can set it in your `.qwen/settings.json` file to save the token usage.
For example, if you want to set the max session token limit to 32000, you can set it like this:

```json
{
  "sessionTokenLimit": 32000
}
```

The max session means the maximum number of tokens that can be used in one chat (not the total usage during multiple tool call shoots); if you reach the limit, you can use the `/compress` command to compress the history and go on, or use `/clear` command to clear the history.

### API Configuration

Set your Qwen API key (In Qwen Code project, you can also set your API key in `.env` file). the `.env` file should be placed in the root directory of your current project.

> ⚠️ **Notice:** <br>
> **If you are in mainland China, please go to https://bailian.console.aliyun.com/ or https://modelscope.cn/docs/model-service/API-Inference/intro to apply for your API key** <br>
> **If you are not in mainland China, please go to https://modelstudio.console.alibabacloud.com/ to apply for your API key**

If you are in mainland China, you can use Qwen3-Coder through the Alibaba Cloud bailian platform.

```bash
export OPENAI_API_KEY="your_api_key_here"
export OPENAI_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1"
export OPENAI_MODEL="qwen3-coder-plus"
```

If you are in mainland China, ModelScope offers 2,000 free model inference API calls per day. Please make sure you connect your aliyun account to ModelScope so that you won't receive the API error like `API Error: OpenAI API error`.

```bash
export OPENAI_API_KEY="your_api_key_here"
export OPENAI_BASE_URL="https://api-inference.modelscope.cn/v1"
export OPENAI_MODEL="Qwen/Qwen3-Coder-480B-A35B-Instruct"
```

If you are not in mainland China, you can use Qwen3-Coder through the Alibaba Cloud modelstuido platform.

```bash
export OPENAI_API_KEY="your_api_key_here"
export OPENAI_BASE_URL="https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
export OPENAI_MODEL="qwen3-coder-plus"
```

OpenRouter also provides free Qwen3-Coder model access:

```bash
export OPENAI_API_KEY="your_api_key_here"
export OPENAI_BASE_URL=https://openrouter.ai/api/v1
export OPENAI_MODEL="qwen/qwen3-coder:free"
```

#### Using Hugging Face Inference Providers

You can also use Qwen Code with [Hugging Face Inference Providers](https://huggingface.co/docs/inference-providers/en/index). 

To do that, grab your [Hugging Face Token](https://huggingface.co/settings/tokens) and create the environment variables below (or add them to your `.env` file).

```bash
export OPENAI_API_KEY="your_huggingface_api_key" 
export OPENAI_BASE_URL="https://router.huggingface.co/v1"
export OPENAI_MODEL="Qwen/Qwen3-Coder-480B-A35B-Instruct"
```

You can check which providers are compatible with this model at https://huggingface.co/inference/models



## Usage Examples

### Explore Codebases

```sh
cd your-project/
qwen
> Describe the main pieces of this system's architecture
```

### Code Development

```sh
> Refactor this function to improve readability and performance
```

### Automate Workflows

```sh
> Analyze git commits from the last 7 days, grouped by feature and team member
```

```sh
> Convert all images in this directory to PNG format
```

## Popular Tasks

### Understand New Codebases

```text
> What are the core business logic components?
> What security mechanisms are in place?
> How does the data flow work?
```

### Code Refactoring & Optimization

```text
> What parts of this module can be optimized?
> Help me refactor this class to follow better design patterns
> Add proper error handling and logging
```

### Documentation & Testing

```text
> Generate comprehensive JSDoc comments for this function
> Write unit tests for this component
> Create API documentation
```

## Benchmark Results

### Terminal-Bench

| Agent     | Model              | Accuracy |
| --------- | ------------------ | -------- |
| Qwen Code | Qwen3-Coder-480A35 | 37.5     |

## Project Structure

```
qwen-code/
├── packages/           # Core packages
├── docs/              # Documentation
├── examples/          # Example code
└── tests/            # Test files
```

## Development & Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) to learn how to contribute to the project.

## Troubleshooting

If you encounter issues, check the [troubleshooting guide](docs/troubleshooting.md).

## Acknowledgments

This project is based on [Google Gemini CLI](https://github.com/google-gemini/gemini-cli). We acknowledge and appreciate the excellent work of the Gemini CLI team. Our main contribution focuses on parser-level adaptations to better support Qwen-Coder models.

## License

[LICENSE](./LICENSE)

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=QwenLM/qwen-code&type=Date)](https://www.star-history.com/#QwenLM/qwen-code&Date)
