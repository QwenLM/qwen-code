# Github Actions：qwen-code-action

## Overview

`qwen-code-action` is a GitHub Action that integrates [Qwen Code] into your development workflow via the [Qwen Code CLI]. It acts both as an autonomous agent for critical routine coding tasks, and an on-demand collaborator you can quickly delegate work to.

Use it to perform GitHub pull request reviews, triage issues, perform code analysis and modification, and more using [Qwen Code] conversationally (e.g., `@qwencoder fix this issue`) directly inside your GitHub repositories.

## Features

- **Automation**: Trigger workflows based on events (e.g. issue opening) or schedules (e.g. nightly).
- **On-demand Collaboration**: Trigger workflows in issue and pull request
  comments by mentioning the [Qwen Code CLI](./features/commands) (e.g., `@qwencoder /review`).
- **Extensible with Tools**: Leverage [Qwen Code](../developers/tools/introduction.md) models' tool-calling capabilities to interact with other CLIs like the [GitHub CLI] (`gh`).
- **Customizable**: Use a `QWEN.md` file in your repository to provide
  project-specific instructions and context to [Qwen Code CLI](./features/commands).

## Quick Start

Get started with Qwen Code CLI in your repository in just a few minutes:

### 1. Get a Qwen API Key

Obtain your API key from [DashScope](https://help.aliyun.com/zh/model-studio/qwen-code) (Alibaba Cloud's AI platform)

### 2. Add it as a GitHub Secret

Store your API key as a secret named `QWEN_API_KEY` in your repository:

- Go to your repository's **Settings > Secrets and variables > Actions**
- Click **New repository secret**
- Name: `QWEN_API_KEY`, Value: your API key

### 3. Update your .gitignore

Add the following entries to your `.gitignore` file:

```gitignore
# qwen-code-cli settings
.qwen/

# GitHub App credentials
gha-creds-*.json
```

### 4. Choose a Workflow

You have two options to set up a workflow:

**Option A: Use setup command (Recommended)**

1. Start the Qwen Code CLI in your terminal:

   ```shell
   qwen
   ```

2. In Qwen Code CLI in your terminal, type:

   ```
   /setup-github
   ```

**Option B: Manually copy workflows**

1. Copy the pre-built workflows from the [`examples/workflows`](./common-workflow) directory to your repository's `.github/workflows` directory. Note: the `qwen-dispatch.yml` workflow must also be copied, which triggers the workflows to run.

### 5. Try it out

**Pull Request Review:**

- Open a pull request in your repository and wait for automatic review
- Comment `@qwencoder /review` on an existing pull request to manually trigger a review

**Issue Triage:**

- Open an issue and wait for automatic triage
- Comment `@qwencoder /triage` on existing issues to manually trigger triaging

**General AI Assistance:**

- In any issue or pull request, mention `@qwencoder` followed by your request
- Examples:
  - `@qwencoder explain this code change`
  - `@qwencoder suggest improvements for this function`
  - `@qwencoder help me debug this error`
  - `@qwencoder write unit tests for this component`

## Workflows

This action provides several pre-built workflows for different use cases. Each workflow is designed to be copied into your repository's `.github/workflows` directory and customized as needed.

### Qwen Code Dispatch

This workflow acts as a central dispatcher for Qwen Code CLI, routing requests to the appropriate workflow based on the triggering event and the command provided in the comment. For a detailed guide on how to set up the dispatch workflow, go to the [Qwen Code Dispatch workflow documentation](./common-workflow).

### Issue Triage

This action can be used to triage GitHub Issues automatically or on a schedule. For a detailed guide on how to set up the issue triage system, go to the [GitHub Issue Triage workflow documentation](./examples/workflows/issue-triage).

### Pull Request Review

This action can be used to automatically review pull requests when they are opened. For a detailed guide on how to set up the pull request review system, go to the [GitHub PR Review workflow documentation](./common-workflow).

### Qwen Code CLI Assistant

This type of action can be used to invoke a general-purpose, conversational Qwen Code AI assistant within the pull requests and issues to perform a wide range of tasks. For a detailed guide on how to set up the general-purpose Qwen Code CLI workflow, go to the [Qwen Code Assistant workflow documentation](./common-workflow).

## Configuration

### Inputs

<!-- BEGIN_AUTOGEN_INPUTS -->

- <a name="__input_qwen_api_key"></a><a href="#user-content-__input_qwen_api_key"><code>qwen*api_key</code></a>: *(Optional)\_ The API key for the Qwen API.

- <a name="__input_qwen_cli_version"></a><a href="#user-content-__input_qwen_cli_version"><code>qwen*cli_version</code></a>: *(Optional, default: `latest`)\_ The version of the Qwen Code CLI to install. Can be "latest", "preview", "nightly", a specific version number, or a git branch, tag, or commit. For more information, see [Qwen Code CLI releases](https://github.com/QwenLM/qwen-code-action/blob/main/docs/releases.md).

- <a name="__input_qwen_debug"></a><a href="#user-content-__input_qwen_debug"><code>qwen*debug</code></a>: *(Optional)\_ Enable debug logging and output streaming.

- <a name="__input_qwen_model"></a><a href="#user-content-__input_qwen_model"><code>qwen*model</code></a>: *(Optional)\_ The model to use with Qwen Code.

- <a name="__input_prompt"></a><a href="#user-content-__input_prompt"><code>prompt</code></a>: _(Optional, default: `You are a helpful assistant.`)_ A string passed to the Qwen Code CLI's [`--prompt` argument](https://github.com/QwenLM/qwen-code-action/blob/main/docs/cli/configuration.md#command-line-arguments).

- <a name="__input_settings"></a><a href="#user-content-__input_settings"><code>settings</code></a>: _(Optional)_ A JSON string written to `.qwen/settings.json` to configure the CLI's _project_ settings.
  For more details, see the documentation on [settings files](https://github.com/QwenLM/qwen-code-action/blob/main/docs/cli/configuration.md#settings-files).

- <a name="__input_use_qwen_code_assist"></a><a href="#user-content-__input_use_qwen_code_assist"><code>use*qwen_code_assist</code></a>: *(Optional, default: `false`)\_ Whether to use Code Assist for Qwen Code model access instead of the default Qwen Code API key.
  For more information, see the [Qwen Code CLI documentation](https://github.com/QwenLM/qwen-code-action/blob/main/docs/cli/authentication.md).

- <a name="__input_use_vertex_ai"></a><a href="#user-content-__input_use_vertex_ai"><code>use*vertex_ai</code></a>: *(Optional, default: `false`)\_ Whether to use Vertex AI for Qwen Code model access instead of the default Qwen Code API key.
  For more information, see the [Qwen Code CLI documentation](https://github.com/QwenLM/qwen-code-action/blob/main/docs/cli/authentication.md).

- <a name="__input_extensions"></a><a href="#user-content-__input_extensions"><code>extensions</code></a>: _(Optional)_ A list of Qwen Code CLI extensions to install.

- <a name="__input_upload_artifacts"></a><a href="#user-content-__input_upload_artifacts"><code>upload*artifacts</code></a>: *(Optional, default: `false`)\_ Whether to upload artifacts to the github action.

- <a name="__input_use_pnpm"></a><a href="#user-content-__input_use_pnpm"><code>use*pnpm</code></a>: *(Optional, default: `false`)\_ Whether or not to use pnpm instead of npm to install qwen-code-cli

- <a name="__input_workflow_name"></a><a href="#user-content-__input_workflow_name"><code>workflow*name</code></a>: *(Optional, default: `${{ github.workflow }}`)\_ The GitHub workflow name, used for telemetry purposes.

<!-- END_AUTOGEN_INPUTS -->

### Outputs

<!-- BEGIN_AUTOGEN_OUTPUTS -->

- <a name="__output_summary"></a><a href="#user-content-__output_summary"><code>summary</code></a>: The summarized output from the Qwen Code CLI execution.

- <a name="__output_error"></a><a href="#user-content-__output_error"><code>error</code></a>: The error output from the Qwen Code CLI execution, if any.

<!-- END_AUTOGEN_OUTPUTS -->

### Repository Variables

We recommend setting the following values as repository variables so they can be reused across all workflows. Alternatively, you can set them inline as action inputs in individual workflows or to override repository-level values.

| Name               | Description                                               | Type     | Required | When Required             |
| ------------------ | --------------------------------------------------------- | -------- | -------- | ------------------------- |
| `DEBUG`            | Enables debug logging for the Qwen Code CLI.              | Variable | No       | Never                     |
| `QWEN_CLI_VERSION` | Controls which version of the Qwen Code CLI is installed. | Variable | No       | Pinning the CLI version   |
| `APP_ID`           | GitHub App ID for custom authentication.                  | Variable | No       | Using a custom GitHub App |

To add a repository variable:

1. Go to your repository's **Settings > Secrets and variables > Actions > New variable**.
2. Enter the variable name and value.
3. Save.

For details about repository variables, refer to the [GitHub documentation on variables][variables].

### Secrets

You can set the following secrets in your repository:

| Name              | Description                                   | Required | When Required                              |
| ----------------- | --------------------------------------------- | -------- | ------------------------------------------ |
| `QWEN_API_KEY`    | Your Qwen API key from DashScope.             | Yes      | Required for all workflows that call Qwen. |
| `APP_PRIVATE_KEY` | Private key for your GitHub App (PEM format). | No       | Using a custom GitHub App.                 |

To add a secret:

1. Go to your repository's **Settings > Secrets and variables >Actions > New repository secret**.
2. Enter the secret name and value.
3. Save.

For more information, refer to the [official GitHub documentation on creating and using encrypted secrets][secrets].

## Authentication

This action requires authentication to the GitHub API and optionally to Qwen Code services.

### GitHub Authentication

You can authenticate with GitHub in two ways:

1. **Default `GITHUB_TOKEN`:** For simpler use cases, the action can use the
   default `GITHUB_TOKEN` provided by the workflow.
2. **Custom GitHub App (Recommended):** For the most secure and flexible
   authentication, we recommend creating a custom GitHub App.

For detailed setup instructions for both Qwen and GitHub authentication, go to the
[**Authentication documentation**](./configuration/auth).

## Extensions

The Qwen Code CLI can be extended with additional functionality through extensions.
These extensions are installed from source from their GitHub repositories.

For detailed instructions on how to set up and configure extensions, go to the
[Extensions documentation](../developers/extensions/extension).

## Best Practices

To ensure the security, reliability, and efficiency of your automated workflows, we strongly recommend following our best practices. These guidelines cover key areas such as repository security, workflow configuration, and monitoring.

Key recommendations include:

- **Securing Your Repository:** Implementing branch and tag protection, and restricting pull request approvers.
- **Monitoring and Auditing:** Regularly reviewing action logs and enabling OpenTelemetry for deeper insights into performance and behavior.

For a comprehensive guide on securing your repository and workflows, please refer to our [**Best Practices documentation**](./common-workflow).

## Customization

Create a QWEN.md file in the root of your repository to provide
project-specific context and instructions to [Qwen Code CLI](./common-workflow). This is useful for defining
coding conventions, architectural patterns, or other guidelines the model should
follow for a given repository.

## Contributing

Contributions are welcome! Check out the Qwen Code CLI **Contributing Guide** for more details on how to get started.

[secrets]: https://docs.github.com/en/actions/security-guides/using-secrets-in-github-actions
[Qwen Code]: https://github.com/QwenLM/qwen-code
[DashScope]: https://dashscope.console.aliyun.com/apiKey
[Qwen Code CLI]: https://github.com/QwenLM/qwen-code-action/
[variables]: https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-variables#creating-configuration-variables-for-a-repository
[GitHub CLI]: https://docs.github.com/en/github-cli/github-cli
[QWEN.md]: https://github.com/QwenLM/qwen-code-action/blob/main/docs/cli/configuration.md#context-files-hierarchical-instructional-context
