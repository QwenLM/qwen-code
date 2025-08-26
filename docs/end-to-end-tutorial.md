# Qwen Code: End-to-End Tutorial

Welcome to the Qwen Code end-to-end tutorial! This guide will walk you through the process of installing, configuring, and using Qwen Code to enhance your development workflow. By the end of this tutorial, you will be able to use Qwen Code to explore new codebases, refactor existing code, and automate common development tasks.

## Table of Contents

1.  [Installation](#installation)
2.  [API Configuration](#api-configuration)
3.  [First Steps: The Interactive CLI](#first-steps-the-interactive-cli)
4.  [Exploring a Codebase](#exploring-a-codebase)
5.  [Refactoring Code](#refactoring-code)
6.  [Automating Tasks](#automating-tasks)
7.  [Non-Interactive Mode](#non-interactive-mode)
8.  [Next Steps](#next-steps)

---

## 1. Installation

Before you can use Qwen Code, you need to make sure you have Node.js version 20 or higher installed on your system. You can check your Node.js version by running the following command in your terminal:

```bash
node -v
```

If you don't have Node.js installed, you can download it from the [official website](https://nodejs.org/).

Once you have Node.js installed, you can install Qwen Code globally using npm:

```bash
npm install -g @qwen-code/qwen-code@latest
```

After the installation is complete, you can verify that it was successful by running:

```bash
qwen --version
```

This should print the version number of Qwen Code.

## 2. API Configuration

Qwen Code requires an API key from a supported provider to function. The supported providers are:

*   **Alibaba Cloud Bailian** (for users in mainland China)
*   **ModelScope** (for users in mainland China, with a free tier)
*   **Alibaba Cloud ModelStudio** (for international users)
*   **OpenRouter** (for international users, with a free tier)

You will need to obtain an API key from one of these providers. Once you have your API key, you need to configure Qwen Code to use it. The easiest way to do this is by setting environment variables.

For example, if you are using OpenRouter, you would set the following environment variables:

```bash
export OPENAI_API_KEY="your_openrouter_api_key"
export OPENAI_BASE_URL="https://openrouter.ai/api/v1"
export OPENAI_MODEL="qwen/qwen3-coder:free"
```

You can add these lines to your shell's configuration file (e.g., `~/.bashrc`, `~/.zshrc`) to make them permanent.

## 3. First Steps: The Interactive CLI

Now that you have Qwen Code installed and configured, you can start using it. The main way to interact with Qwen Code is through its interactive command-line interface (CLI).

To start the interactive CLI, simply run the following command in your terminal:

```bash
qwen
```

This will launch the Qwen Code interface, and you will be greeted with a welcome message. You can now start asking questions and giving instructions to the AI.

Try asking a simple question, like:

> What can you do?

The AI will respond with a summary of its capabilities.

### Session Commands

The interactive CLI has a few special commands for managing the session:

*   `/help`: Display available commands.
*   `/clear`: Clear the conversation history.
*   `/compress`: Compress the conversation history to save tokens.
*   `/status`: Show the current session information, including token usage.
*   `/exit` or `/quit`: Exit the Qwen Code CLI.

## 4. Exploring a Codebase

One of the most powerful features of Qwen Code is its ability to understand and analyze large codebases. Let's try this out on the Qwen Code project itself.

First, clone the Qwen Code repository from GitHub:

```bash
git clone https://github.com/QwenLM/qwen-code.git
cd qwen-code
```

Now, start the Qwen Code CLI from within the project's root directory:

```bash
qwen
```

Once the CLI is running, you can ask questions about the codebase. For example:

> Describe the main pieces of this system's architecture.

Qwen Code will analyze the project structure and provide you with a high-level overview of the architecture, similar to the one we created in the technical explainer.

You can also ask more specific questions, such as:

> What are the key dependencies and how do they interact?
> Find all API endpoints and their authentication methods.

## 5. Refactoring Code

Qwen Code can also help you refactor your code. Let's say you have a function that you want to improve. You can ask Qwen Code to refactor it for you.

For example, you could ask:

> Help me refactor the `main` function in `packages/cli/src/gemini.tsx` to improve its readability.

Qwen Code will analyze the function and suggest a refactored version. It might break the function down into smaller, more manageable pieces, or it might suggest changes to the variable names to make them more descriptive.

## 6. Automating Tasks

Qwen Code can automate a wide range of development tasks. Here are a few examples of what you can do:

*   **Generate documentation:**
    > Generate comprehensive JSDoc comments for all public APIs in `packages/core/index.ts`.
*   **Write unit tests:**
    > Write unit tests with edge cases for the `parseArguments` function in `packages/cli/src/config/config.ts`.
*   **Perform file operations:**
    > Find and remove all `console.log` statements from the `packages/cli` directory.

## 7. Non-Interactive Mode

In addition to the interactive CLI, Qwen Code can also be run in non-interactive mode. This is useful for scripting and automation.

To use non-interactive mode, you can pipe a prompt to the `qwen` command:

```bash
echo "What are the core business logic components?" | qwen
```

Qwen Code will execute the prompt and print the result to the console.

## 8. Next Steps

This tutorial has covered the basics of using Qwen Code. There is much more that you can do with the tool, so we encourage you to experiment and explore its capabilities.

Here are a few ideas for what you can do next:

*   Try using Qwen Code on your own projects.
*   Explore the different tools that are available.
*   Create your own custom workflows and scripts.
*   Contribute to the development of Qwen Code on [GitHub](https://github.com/QwenLM/qwen-code).

We hope you enjoy using Qwen Code!
