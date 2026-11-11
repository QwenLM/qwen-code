# Qwen Code 1.0 Preview

[English](./README.md) · [反馈问题](https://github.com/QwenLM/qwen-code/issues)

Qwen Code 是一款开源的终端编程 Agent，你可以用自然语言让它理解代码、实现功能、排查问题和运行测试。1.0 Preview 融合了 [Qoder](https://qoder.com/) 与 Qwen Code 的 Agent 运行框架（Harness）能力。

## Preview 状态与社区贡献

Qwen Code 1.0 目前处于 Preview 阶段，正在快速迭代。我们会尽量保持已有功能和接口的兼容性，但在版本稳定前，部分接口、配置及行为仍可能调整。升级前请留意版本说明。

为集中推进版本迭代，现阶段暂不接受社区 Pull Request。我们预计在 2026 年 12 月之后开放社区 PR，具体安排将在本仓库公布。在此期间，欢迎通过 Issue 反馈问题和提出建议。

## 快速开始

### 1. 安装 Qwen Code

**Windows（PowerShell）：**

```powershell
irm https://qwen-code.oss-accelerate.aliyuncs.com/install.ps1 | iex
```

**Linux / macOS：**

```sh
curl -fsSL 'https://qwen-code.oss-accelerate.aliyuncs.com/install.sh' | bash
```

安装后，打开新终端，进入你的项目目录并启动 Qwen Code：

```sh
cd my-project
qwen
```

### 2. 连接模型

启动后，按提示登录或配置模型服务。之后可以输入 `/auth` 切换连接方式。

| 连接入口                                | 使用方式                                                    |
| --------------------------------------- | ----------------------------------------------------------- |
| Qwen Account 或 Qoder                   | 按提示登录对应账号。                                        |
| QwenCloud 或 Alibaba Cloud Model Studio | 按所用服务选择套餐或 API Key 接入。                         |
| Other Providers 或 Custom Provider      | 选择已有服务商，或自行填写兼容服务的 API 地址、密钥和模型。 |

连接完成后，用 `/model` 选择模型。可用模型及费用以服务商和账号方案为准。

### 3. 开始对话

可以先让它介绍项目：

```text
这个项目怎么启动？测试怎么运行？
请找到相关配置，并说明文件位置。
```

再尝试一处具体修改：

```text
项目名称为空时，给出错误提示。
请沿用项目现有的校验方式，并运行相关测试。
```

遇到权限提示时，先看清要执行的操作。完成后，用 `/diff` 查看改动，并检查测试结果。输入 `/help` 可以查看可用命令。

## 会话与脚本

回到同一个项目目录，继续上次的会话：

```sh
qwen --continue
```

用 `qwen --resume` 选择历史会话。如果只想执行一次请求并输出结果，可以使用 `-p`：

```sh
qwen -p "介绍一下这个项目，不要修改文件。"
```

在自动化脚本中使用前，请先配置好认证和所需权限。

如需查看命令行选项，运行 `qwen --help`；交互会话中输入 `/help` 查看可用命令。

## 问题反馈

遇到问题时，可以提交 [GitHub Issue](https://github.com/QwenLM/qwen-code/issues)，说明版本、操作系统和复现步骤。附上日志或配置前，请先移除密钥和私有项目数据。

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
