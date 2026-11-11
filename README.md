# Qwen Code 1.0 Preview

[简体中文](./README.zh-CN.md) · [Report an issue](https://github.com/QwenLM/qwen-code/issues)

Qwen Code is an open-source coding agent for your terminal. Ask it in natural language to understand code, implement features, investigate problems, and run tests. The 1.0 Preview brings together the agent harness capabilities of [Qoder](https://qoder.com/) and Qwen Code.

## Preview status and community contributions

Qwen Code 1.0 is in Preview and evolving rapidly. We aim to maintain compatibility with existing features and interfaces, but some interfaces, configuration options, and behaviors may change before the release stabilizes. Please review the release notes before upgrading.

To focus on this phase of development, we are temporarily not accepting community pull requests. We expect to open PR contributions after December 2026 and will announce the details in this repository. In the meantime, issues and suggestions are welcome.

## Get started

### 1. Install Qwen Code

**Windows (PowerShell):**

```powershell
irm https://qwen-code.oss-accelerate.aliyuncs.com/install.ps1 | iex
```

**Linux / macOS:**

```sh
curl -fsSL 'https://qwen-code.oss-accelerate.aliyuncs.com/install.sh' | bash
```

After installation, open a new terminal, enter your project directory, and start Qwen Code:

```sh
cd my-project
qwen
```

### 2. Connect a model

Follow the connection dialog at startup, or enter `/auth` during a session.

| Connection                              | How to start                                                                 |
| --------------------------------------- | ---------------------------------------------------------------------------- |
| Qwen Account or Qoder                   | Choose the corresponding account sign-in entry and follow its requirements.  |
| QwenCloud or Alibaba Cloud Model Studio | Choose an available plan or API key connection.                              |
| Other Providers or Custom Provider      | Select a preset or configure a compatible endpoint, credentials, and models. |

Then use `/model` to choose an available model. Model access and service charges depend on the selected provider and account.

### 3. Try a task

Start by understanding the project:

```text
Explain how this project starts and where its tests are defined.
Read the relevant files and include their paths in your explanation.
```

Then ask for a focused change:

```text
Add validation for an empty project name. Follow the existing validation
patterns and run the tests that cover this change.
```

Review permission prompts before approving tool actions. Use `/diff` to inspect changes and check the reported test results before accepting them. Use `/help` to see the commands available in your session.

## Keep working

Continue the most recent saved session from the same project context:

```sh
qwen --continue
```

Use `qwen --resume` to select an earlier session. For a single request without the interactive terminal interface:

```sh
qwen -p "Explain the purpose of this repository. Do not modify files."
```

Configure authentication and permissions before unattended runs.

Run `qwen --help` for command-line options, or enter `/help` in an interactive session to see available commands.

## Feedback

For bug reports, include your version, operating system, reproduction steps, and relevant sanitized output in a [GitHub issue](https://github.com/QwenLM/qwen-code/issues). Keep credentials and private project data out of public reports.

## License

Qwen Code is developed by Qwen Team. Code is distributed under the
[Apache License, Version 2.0](./LICENSE).

This product contains third-party components under other open source licenses,
including vendored components and portions derived from upstream projects. The
[NOTICE](./NOTICE) file summarizes those components and their licenses at the
component level. The complete list of dependency licenses, including full
license texts, is generated at release time (see the `THIRD-PARTY-LICENSES`
file).

## Acknowledgments

This project was originally based on [Google Gemini CLI](https://github.com/google-gemini/gemini-cli) v0.8.2. We gratefully acknowledge the Gemini CLI team's excellent work. Starting from Qwen Code v0.1, we stopped syncing with upstream and began independent development as a multi-protocol, multi-platform agent framework with deep integrations for Qwen models and beyond.

Portions of this project are derived from [vybestack/llxprt-code](https://github.com/vybestack/llxprt-code), a fork of Google Gemini CLI (Copyright 2025 Vybestack LLC, licensed under the Apache License, Version 2.0). We thank the llxprt-code authors for their work.

This project also vendors a TypeScript-ported fork of [ink](https://github.com/vadimdemedes/ink) (MIT, Copyright (c) Vadym Demedes) and ripgrep packaging based on `@lvce-editor/ripgrep` (MIT, Copyright (c) 2023 Lvce Editor). See the [NOTICE](./NOTICE) file for the full component-level attribution.
