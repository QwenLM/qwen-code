<div align="center">

[![npm version](https://img.shields.io/npm/v/@qwen-code/qwen-code.svg)](https://www.npmjs.com/package/@qwen-code/qwen-code)
[![License](https://img.shields.io/github/license/QwenLM/qwen-code.svg)](./LICENSE)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen.svg)](https://nodejs.org/)
[![Downloads](https://img.shields.io/npm/dm/@qwen-code/qwen-code.svg)](https://www.npmjs.com/package/@qwen-code/qwen-code)

<a href="https://trendshift.io/repositories/15287" target="_blank"><img src="https://trendshift.io/api/badge/repositories/15287" alt="QwenLM%2Fqwen-code | Trendshift" style="width: 250px; height: 55px;" width="250" height="55"/></a>

**一个开源的 AI 代理，运行在你的终端中。**

<a href="https://qwenlm.github.io/qwen-code-docs/en/users/overview">English</a> |
<a href="https://qwenlm.github.io/qwen-code-docs/de/users/overview">Deutsch</a> |
<a href="https://qwenlm.github.io/qwen-code-docs/fr/users/overview">français</a> |
<a href="https://qwenlm.github.io/qwen-code-docs/ja/users/overview">日本語</a> |
<a href="https://qwenlm.github.io/qwen-code-docs/ru/users/overview">Русский</a> |
<a href="https://qwenlm.github.io/qwen-code-docs/pt-BR/users/overview">Português (Brasil)</a>

</div>

> 📖 此中文版本由社区维护。英文版 [README.md](./README.md) 为官方权威版本。

## 🎉 新闻

- **2026-06-17**: 修复 React error #185 — 组件卸载后调用 setState 导致的 CLI UI 层崩溃。为 5 个异步 hook（`useShellHistory`、`useLogger`、`useCommandMigration`、`useGitBranchName`、`useWorktreeSession`）添加了 `let cancelled` 防护模式，并从 `AgentChatContent` 移除了卸载时的 `setState` 调用。([#5199](https://github.com/QwenLM/qwen-code/issues/5199))

- **2026-04-15**: Qwen OAuth 免费层已停止服务。如需继续使用 Qwen Code，请切换到[阿里云百炼 Coding Plan](https://modelstudio.console.alibabacloud.com/?tab=coding-plan#/efm/coding-plan-index)、[OpenRouter](https://openrouter.ai)、[Fireworks AI](https://app.fireworks.ai)，或使用自己的 API Key。运行 `qwen auth` 重新配置。

- **2026-04-13**: Qwen OAuth 免费层策略更新：每日配额调整为 100 次请求/天（之前为 1,000 次）。

- **2026-04-02**: Qwen3.6-Plus 现已上线！从[阿里云百炼 ModelStudio](https://modelstudio.console.alibabacloud.com/ap-southeast-1?tab=doc#/doc/?type=model&url=2840914_2&modelId=qwen3.6-plus) 获取 API Key，通过 OpenAI 兼容接口使用。

- **2026-02-16**: Qwen3.5-Plus 现已上线！

## 为什么选择 Qwen Code？

Qwen Code 是一个开源的终端 AI 代理，专为 Qwen 系列模型优化。它帮助你理解大型代码库、自动化繁琐工作并加速交付。

- **多协议、灵活的提供商**：支持 OpenAI / Anthropic / Gemini 兼容 API、[阿里云百炼 Coding Plan](https://modelstudio.console.alibabacloud.com/?tab=coding-plan#/efm/coding-plan-index)、[OpenRouter](https://openrouter.ai)、[Fireworks AI](https://app.fireworks.ai)，或使用你自己的 API Key。
- **开源、共同进化**：框架和 Qwen3-Coder 模型都是开源的——它们一起发布和进化。
- **代理工作流、功能丰富**：丰富的内置工具（Skills、SubAgents）提供完整的代理工作流体验，类似 Claude Code。
- **终端优先、IDE 友好**：为在命令行中工作的开发者设计，同时可选集成 VS Code、Zed 和 JetBrains IDE。

![](https://gw.alicdn.com/imgextra/i1/O1CN01D2DviS1wwtEtMwIzJ_!!6000000006373-2-tps-1600-900.png)

## 安装

### 快速安装（推荐）

#### Linux / macOS

```bash
curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh | bash
```

#### Windows

```powershell
irm https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.ps1 | iex
```

> **注意**：建议安装后重启终端以确保环境变量生效。

### 手动安装

#### 系统要求

确保你已安装 Node.js 22 或更高版本。从 [nodejs.org](https://nodejs.org/en/download) 下载。

#### NPM

```bash
npm install -g @qwen-code/qwen-code@latest
```

#### Homebrew（macOS、Linux）

```bash
brew install qwen-code
```

## 快速开始

```bash
# 启动 Qwen Code（交互模式）
qwen

# 然后在会话中：
/help
/auth
```

首次使用时会提示登录。你可以随时运行 `/auth` 切换认证方式。

示例提示词：

```text
这个项目是做什么的？
解释代码库结构。
帮我重构这个函数。
为此模块生成单元测试。
```

<details>
<summary>点击观看演示视频</summary>

<video src="https://cloud.video.taobao.com/vod/HLfyppnCHplRV9Qhz2xSqeazHeRzYtG-EYJnHAqtzkQ.mp4" controls>
你的浏览器不支持 video 标签。
</video>

</details>

## 🦞 在 Claw 中使用 Qwen Code 进行编码任务

将以下提示词复制并粘贴到你的代理中：

```
Use Qwen Code as a coding agent. First, fetch and read this skill reference:
https://raw.githubusercontent.com/QwenLM/qwen-code/refs/heads/main/.qwen/skills/qwen-code-claw/SKILL.md
Then follow the instructions inside to install, authenticate, and use Qwen Code via acpx for all coding tasks.
```

## 认证方式

Qwen Code 支持以下认证方式：

- **API Key（推荐）**：使用来自阿里云百炼 ModelStudio（[国内站](https://bailian.console.aliyun.com/) / [国际站](https://modelstudio.console.alibabacloud.com/)）或任何支持的提供商（OpenAI、Anthropic、Google GenAI 及其他兼容端点）的 API Key。
- **Coding Plan**：订阅阿里云百炼 Coding Plan（[国内站](https://bailian.console.aliyun.com/cn-beijing?tab=coding-plan#/efm/coding-plan-index) / [国际站](https://modelstudio.console.alibabacloud.com/?tab=coding-plan#/efm/coding-plan-index)），按月付费，配额更高。

> ⚠️ **Qwen OAuth 已于 2026 年 4 月 15 日停止服务。** 如果你之前使用 Qwen OAuth，请切换到上述方式之一。运行 `qwen`，然后运行 `/auth` 重新配置。

#### API Key（推荐）

使用 API Key 连接到阿里云百炼 ModelStudio 或任何支持的提供商。支持多种协议：

- **OpenAI 兼容**：阿里云百炼 ModelStudio、ModelScope、OpenAI、OpenRouter 及其他 OpenAI 兼容提供商
- **Anthropic**：Claude 模型
- **Google GenAI**：Gemini 模型

**推荐**的配置方式是在 `~/.qwen/settings.json` 中编辑（如果不存在则创建）。此文件允许你在一个地方定义所有可用的模型、API Key 和默认设置。

##### 三步快速配置

**第一步：** 创建或编辑 `~/.qwen/settings.json`

以下是一个完整示例：

```json
{
  "modelProviders": {
    "openai": [
      {
        "id": "qwen3.6-plus",
        "name": "qwen3.6-plus",
        "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "description": "通过 Dashscope 使用 Qwen3-Coder",
        "envKey": "DASHSCOPE_API_KEY"
      }
    ]
  },
  "env": {
    "DASHSCOPE_API_KEY": "sk-xxxxxxxxxxxxx"
  },
  "security": {
    "auth": {
      "selectedType": "openai"
    }
  },
  "model": {
    "name": "qwen3.6-plus"
  }
}
```

**第二步：** 理解每个字段

| 字段 | 作用 |
| --- | --- |
| `modelProviders` | 声明哪些模型可用以及如何连接。如 `openai`、`anthropic`、`gemini` 代表 API 协议。 |
| `modelProviders[].id` | 发送给 API 的模型 ID（如 `qwen3.6-plus`、`gpt-4o`）。 |
| `modelProviders[].envKey` | 保存 API Key 的环境变量名称。 |
| `modelProviders[].baseUrl` | API 端点 URL（非默认端点时需要）。 |
| `env` | 备用存储 API Key 的地方（优先级最低；敏感 Key 优先使用 `.env` 文件或 `export`）。 |
| `security.auth.selectedType` | 启动时使用的协议（`openai`、`anthropic`、`gemini`、`vertex-ai`）。 |
| `model.name` | Qwen Code 启动时使用的默认模型。 |

**第三步：** 启动 Qwen Code——配置自动生效：

```bash
qwen
```

随时使用 `/model` 命令切换所有已配置的模型。

##### 更多示例

<details>
<summary>Coding Plan（阿里云百炼 ModelStudio）— 按月付费，配额更高</summary>

```json
{
  "modelProviders": {
    "openai": [
      {
        "id": "qwen3.6-plus",
        "name": "qwen3.6-plus (Coding Plan)",
        "baseUrl": "https://coding.dashscope.aliyuncs.com/v1",
        "description": "来自 ModelStudio Coding Plan 的 qwen3.6-plus",
        "envKey": "BAILIAN_CODING_PLAN_API_KEY"
      },
      {
        "id": "qwen3.5-plus",
        "name": "qwen3.5-plus (Coding Plan)",
        "baseUrl": "https://coding.dashscope.aliyuncs.com/v1",
        "description": "来自 ModelStudio Coding Plan 的 qwen3.5-plus（开启思考）",
        "envKey": "BAILIAN_CODING_PLAN_API_KEY",
        "generationConfig": {
          "extra_body": {
            "enable_thinking": true
          }
        }
      }
    ]
  },
  "env": {
    "BAILIAN_CODING_PLAN_API_KEY": "sk-xxxxxxxxxxxxx"
  },
  "security": {
    "auth": {
      "selectedType": "openai"
    }
  },
  "model": {
    "name": "qwen3.6-plus"
  }
}
```

> 前往[阿里云百炼 ModelStudio（国内站）](https://bailian.console.aliyun.com/cn-beijing?tab=coding-plan#/efm/coding-plan-index)或[阿里云百炼 ModelStudio（国际站）](https://modelstudio.console.alibabacloud.com/?tab=coding-plan#/efm/coding-plan-index)订阅 Coding Plan 并获取 API Key。

</details>

<details>
<summary>多提供商（OpenAI + Anthropic + Gemini）</summary>

```json
{
  "modelProviders": {
    "openai": [
      {
        "id": "gpt-4o",
        "name": "GPT-4o",
        "envKey": "OPENAI_API_KEY",
        "baseUrl": "https://api.openai.com/v1"
      }
    ],
    "anthropic": [
      {
        "id": "claude-sonnet-4-20250514",
        "name": "Claude Sonnet 4",
        "envKey": "ANTHROPIC_API_KEY"
      }
    ],
    "gemini": [
      {
        "id": "gemini-2.5-pro",
        "name": "Gemini 2.5 Pro",
        "envKey": "GEMINI_API_KEY"
      }
    ]
  },
  "env": {
    "OPENAI_API_KEY": "sk-xxxxxxxxxxxxx",
    "ANTHROPIC_API_KEY": "sk-ant-xxxxxxxxxxxxx",
    "GEMINI_API_KEY": "AIzaxxxxxxxxxxxxx"
  },
  "security": {
    "auth": {
      "selectedType": "openai"
    }
  },
  "model": {
    "name": "gpt-4o"
  }
}
```

</details>

<details>
<summary>启用思考模式（适用于 qwen3.5-plus 等支持思考的模型）</summary>

```json
{
  "modelProviders": {
    "openai": [
      {
        "id": "qwen3.5-plus",
        "name": "qwen3.5-plus (thinking)",
        "envKey": "DASHSCOPE_API_KEY",
        "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "generationConfig": {
          "extra_body": {
            "enable_thinking": true
          }
        }
      }
    ]
  },
  "env": {
    "DASHSCOPE_API_KEY": "sk-xxxxxxxxxxxxx"
  },
  "security": {
    "auth": {
      "selectedType": "openai"
    }
  },
  "model": {
    "name": "qwen3.5-plus"
  }
}
```

</details>

> **提示：** 你也可以通过 shell 中的 `export` 或 `.env` 文件设置 API Key，它们的优先级高于 `settings.json` → `env`。详见[认证指南](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/)。

> **安全提示：** 切勿将 API Key 提交到版本控制。`~/.qwen/settings.json` 位于你的主目录，应保持私有。

#### 本地模型配置（Ollama / vLLM）

你也可以在本地运行模型——无需 API Key 或云账号。这不是认证方式，而是通过 `~/.qwen/settings.json` 中的 `modelProviders` 字段配置本地模型端点。

在匹配的 provider 条目内设置 `generationConfig.contextWindowSize`，并将其调整为本地服务器上配置的上下文长度。

<details>
<summary>Ollama 配置</summary>

1. 从 [ollama.com](https://ollama.com/) 安装 Ollama
2. 拉取模型：`ollama pull qwen3:32b`
3. 配置 `~/.qwen/settings.json`：

```json
{
  "modelProviders": {
    "openai": [
      {
        "id": "qwen3:32b",
        "name": "Qwen3 32B (Ollama)",
        "baseUrl": "http://localhost:11434/v1",
        "description": "通过 Ollama 在本地运行 Qwen3 32B",
        "generationConfig": {
          "contextWindowSize": 131072
        }
      }
    ]
  },
  "security": {
    "auth": {
      "selectedType": "openai"
    }
  },
  "model": {
    "name": "qwen3:32b"
  }
}
```

</details>

<details>
<summary>vLLM 配置</summary>

1. 安装 vLLM：`pip install vllm`
2. 启动服务器：`vllm serve Qwen/Qwen3-32B`
3. 配置 `~/.qwen/settings.json`：

```json
{
  "modelProviders": {
    "openai": [
      {
        "id": "Qwen/Qwen3-32B",
        "name": "Qwen3 32B (vLLM)",
        "baseUrl": "http://localhost:8000/v1",
        "description": "通过 vLLM 在本地运行 Qwen3 32B",
        "generationConfig": {
          "contextWindowSize": 131072
        }
      }
    ]
  },
  "security": {
    "auth": {
      "selectedType": "openai"
    }
  },
  "model": {
    "name": "Qwen/Qwen3-32B"
  }
}
```

</details>

## 使用方式

作为一个开源的终端 AI 代理，你可以通过五种主要方式使用 Qwen Code：

1. 交互模式（终端 UI）
2. 无头模式（脚本、CI）
3. IDE 集成（VS Code、Zed）
4. SDK（TypeScript、Python、Java）
5. 守护进程模式 — `qwen serve` 通过 HTTP+SSE 暴露 ACP，让多个客户端共享一个代理（实验性）

#### 交互模式

```bash
cd your-project/
qwen
```

在项目文件夹中运行 `qwen` 启动交互式终端 UI。使用 `@` 引用本地文件（例如 `@src/main.ts`）。

#### 无头模式

```bash
cd your-project/
qwen -p "你的问题"
```

使用 `-p` 参数运行 Qwen Code 而无需交互 UI —— 适用于脚本、自动化和 CI/CD。了解更多：[无头模式](https://qwenlm.github.io/qwen-code-docs/en/users/features/headless)。

#### IDE 集成

在编辑器中使用 Qwen Code（VS Code、Zed 和 JetBrains IDE）：

- [在 VS Code 中使用](https://qwenlm.github.io/qwen-code-docs/en/users/integration-vscode/)
- [在 Zed 中使用](https://qwenlm.github.io/qwen-code-docs/en/users/integration-zed/)
- [在 JetBrains IDE 中使用](https://qwenlm.github.io/qwen-code-docs/en/users/integration-jetbrains/)

#### 守护进程模式（`qwen serve`，实验性）

```bash
cd your-project/
qwen serve
# → qwen serve listening on http://127.0.0.1:4170 (mode=http-bridge)
```

将 Qwen Code 作为本地 HTTP 守护进程运行，以便 IDE 插件、Web UI、CI 脚本和自定义 CLI 都能**共享**一个代理会话——而不是各自启动子进程。回环绑定默认无认证（设置 `QWEN_SERVER_TOKEN` 可在回环上也启用 Bearer 认证）；远程绑定（`--hostname 0.0.0.0`）**必需** token——缺少 token 时启动被拒绝。参见：

- [守护进程模式用户指南](https://qwenlm.github.io/qwen-code-docs/en/users/qwen-serve)
- [HTTP 协议参考](https://qwenlm.github.io/qwen-code-docs/en/developers/qwen-serve-protocol)
- [DaemonClient TypeScript 快速入门](https://qwenlm.github.io/qwen-code-docs/en/developers/examples/daemon-client-quickstart)

#### SDK

基于 Qwen Code 构建：

- TypeScript：[使用 Qwen Code SDK](./packages/sdk-typescript/README.md)
- Python：[使用 Python SDK](./packages/sdk-python/README.md)
- Java：[使用 Java SDK](./packages/sdk-java/qwencode/README.md)

Python SDK 示例：

```python
import asyncio

from qwen_code_sdk import is_sdk_result_message, query


async def main() -> None:
    result = query(
        "总结仓库布局。",
        {
            "cwd": "/path/to/project",
            "path_to_qwen_executable": "qwen",
        },
    )

    async for message in result:
        if is_sdk_result_message(message):
            print(message["result"])


asyncio.run(main())
```

## 命令与快捷键

### 会话命令

- `/help` — 显示可用命令
- `/clear` — 清除对话历史
- `/compress` — 压缩历史以节省 token
- `/stats` — 显示当前会话信息
- `/bug` — 提交 Bug 报告
- `/exit` 或 `/quit` — 退出 Qwen Code

### 键盘快捷键

- `Ctrl+C` — 取消当前操作
- `Ctrl+D` — 退出（空行时）
- `上/下` — 浏览命令历史

> 了解更多关于[命令](https://qwenlm.github.io/qwen-code-docs/en/users/features/commands/)的信息
>
> **提示**：在 YOLO 模式（`--yolo`）下，检测到图片时自动切换视觉模式而无需提示。了解更多关于[审批模式](https://qwenlm.github.io/qwen-code-docs/en/users/features/approval-mode/)。

## 配置

Qwen Code 可通过 `settings.json`、环境变量和 CLI 参数进行配置。

| 文件 | 范围 | 描述 |
| --- | --- | --- |
| `~/.qwen/settings.json` | 用户（全局） | 适用于所有 Qwen Code 会话。**推荐用于 `modelProviders` 和 `env`。** |
| `.qwen/settings.json` | 项目 | 仅在该项目中运行 Qwen Code 时生效。覆盖用户设置。 |

`settings.json` 中最常用的顶级字段：

| 字段 | 描述 |
| --- | --- |
| `modelProviders` | 按协议定义可用模型（`openai`、`anthropic`、`gemini`、`vertex-ai`）。 |
| `env` | 备用环境变量（如 API Key）。优先级低于 shell `export` 和 `.env` 文件。 |
| `security.auth.selectedType` | 启动时使用的协议（如 `openai`）。 |
| `model.name` | Qwen Code 启动时使用的默认模型。 |

> 参见上方[认证](#api-key推荐)部分获取完整的 `settings.json` 示例，以及[设置参考](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/settings/)获取所有可用选项。

## 基准测试结果

### Terminal-Bench 性能

| 代理 | 模型 | 准确率 |
| --- | --- | --- |
| Qwen Code | Qwen3-Coder-480A35 | 37.5% |
| Qwen Code | Qwen3-Coder-30BA3B | 31.3% |

## 生态系统

寻找图形界面？

- [**Qwen Code Desktop**](https://github.com/QwenLM/qwen-code/releases/tag/desktop-latest) 官方桌面应用（macOS、Windows、Linux）
- [**AionUi**](https://github.com/iOfficeAI/AionUi) 为包括 Qwen Code 在内的命令行 AI 工具提供的现代 GUI
- [**Gemini CLI Desktop**](https://github.com/Piebald-AI/gemini-cli-desktop) 面向 Qwen Code 的跨平台桌面/Web/移动端 UI

## 故障排除

如果遇到问题，请查看[故障排除指南](https://qwenlm.github.io/qwen-code-docs/en/users/support/troubleshooting/)。

**常见问题：**

- **`Qwen OAuth 免费层已于 2026-04-15 停止服务`**：Qwen OAuth 已不再可用。运行 `qwen` → `/auth` 切换到 API Key 或 Coding Plan。参见上方[认证](#api-key推荐)部分的配置说明。

要报告 Bug，请在 CLI 中运行 `/bug` 并附带简短的标题和复现步骤。

## 联系我们

- Discord: https://discord.gg/RN7tqZCeDK
- 钉钉: https://qr.dingtalk.com/action/joingroup?code=v1,k1,+FX6Gf/ZDlTahTIRi8AEQhIaBlqykA0j+eBKKdhLeAE=&_dt_no_comment=1&origin=1

## 致谢

本项目基于 [Google Gemini CLI](https://github.com/google-gemini/gemini-cli)。我们感谢并认可 Gemini CLI 团队的出色工作。我们的主要贡献侧重于解析器级别的适配，以更好地支持 Qwen-Coder 模型。
