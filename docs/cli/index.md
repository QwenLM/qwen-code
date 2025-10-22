# Qwen Code CLI

Within Qwen Code, `packages/cli` is the frontend for users to send and receive prompts with Qwen and other AI models and their associated tools. For a general overview of Qwen Code

## Navigating this section

- **[Authentication](./authentication.md):** A guide to setting up authentication with Qwen OAuth and OpenAI-compatible providers.
- **[Commands](./commands.md):** A reference for Qwen Code CLI commands (e.g., `/help`, `/tools`, `/theme`).
- **[Configuration](./configuration.md):** A guide to tailoring Qwen Code CLI behavior using configuration files.
- **[Themes](./themes.md)**: A guide to customizing the CLI's appearance with different themes.
- **[Tutorials](tutorials.md)**: A tutorial showing how to use Qwen Code to automate a development task.

## Non-interactive mode

Qwen Code can be run in a non-interactive mode, which is useful for scripting and automation. In this mode, you pipe input to the CLI, it executes the command, and then it exits.

The following example pipes a command to Qwen Code from your terminal:

```bash
echo "What is fine tuning?" | qwen
```

You can also use the `--prompt` or `-p` flag:

```bash
qwen -p "What is fine tuning?"
```

For comprehensive documentation on headless usage, scripting, automation, and advanced examples, see the **[Headless Mode](../headless.md)** guide.
