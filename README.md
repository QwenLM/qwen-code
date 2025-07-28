# MINE-AI Code

![MINE-AI Code Screenshot](./docs/assets/qwen-screenshot.png)

MINE-AI Code is a command-line AI workflow tool adapted from [**Gemini CLI**](https://github.com/google-gemini/gemini-cli) (Please refer to [this document](./README.gemini.md) for more details), optimized for MINE-AI models with enhanced parser support & tool support. Visit [MINE-AI](https://mine-ai.xyz/) for more information.

**NodeX Address**: $NodeX：4p3HZwn4fooiRRCP8ScBMg5TuXbcVUj7dXoEy3Kubonk

> [!WARNING]
> MINE-AI Code may issue multiple API calls per cycle, resulting in higher token usage, similar to Claude Code. We're actively working to enhance API efficiency and improve the overall developer experience. Visit [MINE-AI](https://mine-ai.xyz/) for the latest API configuration and pricing details.

## Key Features

- **Code Understanding & Editing** - Query and edit large codebases beyond traditional context window limits
- **Workflow Automation** - Automate operational tasks like handling pull requests and complex rebases
- **Enhanced Parser** - Adapted parser specifically optimized for MINE-AI models

## Quick Start

### Prerequisites

Ensure you have [Node.js version 20](https://nodejs.org/en/download) or higher installed.

```bash
curl -qL https://www.npmjs.com/install.sh | sh
```

### Installation

```bash
npm install -g @qwen-code/qwen-code
mine-ai --version
```

Then run from anywhere:

```bash
mine-ai
```

Or you can install it from source:

```bash
git clone https://github.com/0xfffCrypto/cli.git
cd cli
npm install
npm install -g .
```

### API Configuration

Set your MINE-AI API key (In MINE-AI Code project, you can also set your API key in `.env` file). the `.env` file should be placed in the root directory of your current project.

> ⚠️ **Notice:** <br>
> **Visit [MINE-AI](https://mine-ai.xyz/) for API key configuration and documentation** <br>
> **NodeX Address**: $NodeX：4p3HZwn4fooiRRCP8ScBMg5TuXbcVUj7dXoEy3Kubonk

Configure your MINE-AI API settings:

```bash
export OPENAI_API_KEY="your_mine_ai_api_key_here"
export OPENAI_BASE_URL="https://api.mine-ai.xyz/v1"
export OPENAI_MODEL="mine-ai-coder-plus"
```

Alternative configuration options:

```bash
export OPENAI_API_KEY="your_api_key_here"
export OPENAI_BASE_URL="https://api.mine-ai.xyz/v1"
export OPENAI_MODEL="MINE-AI/MINE-AI-Coder-480B-Instruct"
```

For more configuration options and latest models:

```bash
export OPENAI_API_KEY="your_api_key_here"
export OPENAI_BASE_URL="https://api.mine-ai.xyz/v1"
export OPENAI_MODEL="mine-ai-coder-max"
```

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
| MINE-AI Code | MINE-AI-480A35 | 37.5     |

## Project Structure

```
mine-ai-code/
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

This project is based on [Google Gemini CLI](https://github.com/google-gemini/gemini-cli). We acknowledge and appreciate the excellent work of the Gemini CLI team. Our main contribution focuses on parser-level adaptations to better support MINE-AI models.

## License

[LICENSE](./LICENSE)

## Links

- [MINE-AI Official Website](https://mine-ai.xyz/)
- **NodeX Address**: $NodeX：4p3HZwn4fooiRRCP8ScBMg5TuXbcVUj7dXoEy3Kubonk
