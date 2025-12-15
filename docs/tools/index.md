# Qwen Code tools

Qwen Code includes built-in tools that the model uses to interact with your local environment, access information, and perform actions. These tools enhance the CLI's capabilities, enabling it to go beyond text generation and assist with a wide range of tasks.

## Overview of Qwen Code tools

In the context of Qwen Code, tools are specific functions or modules that the model can request to be executed. For example, if you ask the model to "Summarize the contents of `my_document.txt`," it will likely identify the need to read that file and will request the execution of the `read_file` tool.

The core component (`packages/core`) manages these tools, presents their definitions (schemas) to the model, executes them when requested, and returns the results to the model for further processing into a user-facing response.

These tools provide the following capabilities:

- **Access local information:** Tools allow the model to access your local file system, read file contents, list directories, etc.
- **Execute commands:** With tools like `run_shell_command`, the model can run shell commands (with appropriate safety measures and user confirmation).
- **Interact with the web:** Tools can fetch content from URLs.
- **Take actions:** Tools can modify files, write new files, or perform other actions on your system (again, typically with safeguards).
- **Ground responses:** By using tools to fetch real-time or specific local data, responses can be more accurate, relevant, and grounded in your actual context.

## How to use Qwen Code tools

To use Qwen Code tools, provide a prompt to the CLI. The process works as follows:

1.  You provide a prompt to the CLI.
2.  The CLI sends the prompt to the core.
3.  The core, along with your prompt and conversation history, sends a list of available tools and their descriptions/schemas to the configured model API.
4.  The model analyzes your request. If it determines that a tool is needed, its response will include a request to execute a specific tool with certain parameters.
5.  The core receives this tool request, validates it, and (often after user confirmation for sensitive operations) executes the tool.
6.  The output from the tool is sent back to the model.
7.  The model uses the tool's output to formulate its final answer, which is then sent back through the core to the CLI and displayed to you.

You will typically see messages in the CLI indicating when a tool is being called and whether it succeeded or failed.

## Security and confirmation

Many tools, especially those that can modify your file system or execute commands (`write_file`, `edit`, `run_shell_command`), are designed with safety in mind. Qwen Code will typically:

- **Require confirmation:** Prompt you before executing potentially sensitive operations, showing you what action is about to be taken.
- **Utilize sandboxing:** All tools are subject to restrictions enforced by sandboxing (see [Sandboxing in Qwen Code](../sandbox.md)). This means that when operating in a sandbox, any tools (including MCP servers) you wish to use must be available _inside_ the sandbox environment. For example, to run an MCP server through `npx`, the `npx` executable must be installed within the sandbox's Docker image or be available in the `sandbox-exec` environment.

It's important to always review confirmation prompts carefully before allowing a tool to proceed.

## Learn more about Qwen Code's tools

Qwen Code's built-in tools can be broadly categorized as follows:

- **[File System Tools](./file-system.md):** For interacting with files and directories (reading, writing, listing, searching, etc.).
- **[Shell Tool](./shell.md) (`run_shell_command`):** For executing shell commands.
- **[Web Fetch Tool](./web-fetch.md) (`web_fetch`):** For retrieving content from URLs.
- **[Web Search Tool](./web-search.md) (`web_search`):** For searching the web.
- **[Multi-File Read Tool](./multi-file.md) (`read_many_files`):** A specialized tool for reading content from multiple files or directories, often used by the `@` command.
- **[Memory Tool](./memory.md) (`save_memory`):** For saving and recalling information across sessions.
- **[Todo Write Tool](./todo-write.md) (`todo_write`):** For creating and managing structured task lists during coding sessions.

Additionally, these tools incorporate:

- **[MCP servers](./mcp-server.md)**: MCP servers act as a bridge between the model and your local environment or other services like APIs.
  - **[MCP Quick Start Guide](../mcp-quick-start.md)**: Get started with MCP in 5 minutes with practical examples
  - **[MCP Example Configurations](../mcp-example-configs.md)**: Ready-to-use configurations for common scenarios
  - **[MCP Testing & Validation](../mcp-testing-validation.md)**: Test and validate your MCP server setups
- **[Sandboxing](../sandbox.md)**: Sandboxing isolates the model and its changes from your environment to reduce potential risk.
