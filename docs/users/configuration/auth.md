# Authentication

Qwen Code supports two authentication methods. Pick the one that matches how you want to run the CLI:

- **Qwen OAuth (recommended)**: sign in with your `qwen.ai` account in a browser.
- **API-KEY**: use an API key to connect to any supported provider. More flexible — supports OpenAI, Anthropic, Google GenAI, Alibaba Cloud Bailian, and other compatible endpoints.

![](https://gw.alicdn.com/imgextra/i4/O1CN01yXSXc91uYxJxhJXBF_!!6000000006050-2-tps-2372-916.png)

## 👍 Option 1: Qwen OAuth (recommended & free)

Use this if you want the simplest setup and you're using Qwen models.

- **How it works**: on first start, Qwen Code opens a browser login page. After you finish, credentials are cached locally so you usually won't need to log in again.
- **Requirements**: a `qwen.ai` account + internet access (at least for the first login).
- **Benefits**: no API key management, automatic credential refresh.
- **Cost & quota**: free, with a quota of **60 requests/minute** and **1,000 requests/day**.

Start the CLI and follow the browser flow:

```bash
qwen
```

> [!note]
>
> In non-interactive or headless environments (e.g., CI, SSH, containers), you typically **cannot** complete the OAuth browser login flow.  
> In these cases, please use the API-KEY authentication method.

## 🚀 Option 2: API-KEY (flexible)

Use this if you want more flexibility over which provider and model to use. Supports multiple protocols and providers, including OpenAI, Anthropic, Google GenAI, Alibaba Cloud Bailian, Azure OpenAI, OpenRouter, ModelScope, or a self-hosted compatible endpoint.

### Recommended: One-file setup via `settings.json`

The simplest way to get started with API-KEY authentication is to put everything in a single `~/.qwen/settings.json` file. Here's a complete, ready-to-use example:

```json
{
  "modelProviders": {
    "openai": [
      {
        "id": "qwen3-coder-plus",
        "name": "qwen3-coder-plus",
        "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "description": "Qwen3-Coder via Dashscope",
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
    "name": "qwen3-coder-plus"
  }
}
```

What each field does:

| Field                        | Description                                                                                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `modelProviders`             | Declares which models are available and how to connect to them. Keys (`openai`, `anthropic`, `gemini`, `vertex-ai`) represent the API protocol. |
| `env`                        | Stores API keys directly in `settings.json` as a fallback (lowest priority — shell `export` and `.env` files take precedence).                  |
| `security.auth.selectedType` | Tells Qwen Code which protocol to use on startup (e.g. `openai`, `anthropic`, `gemini`). Without this, you'd need to run `/auth` interactively. |
| `model.name`                 | The default model to activate when Qwen Code starts. Must match one of the `id` values in your `modelProviders`.                                |

After saving the file, just run `qwen` — no interactive `/auth` setup needed.

> [!tip]
>
> The sections below explain each part in more detail. If the quick example above works for you, feel free to skip ahead to [Security notes](#security-notes).

### Option1: Coding Plan（Aliyun Bailian）

Use this if you want predictable costs with higher usage quotas for the qwen3-coder-plus model.

- **How it works**: Subscribe to the Coding Plan with a fixed monthly fee, then configure Qwen Code to use the dedicated endpoint and your subscription API key.
- **Requirements**: Obtain an active Coding Plan subscription from [Alibaba Cloud Bailian](https://bailian.console.aliyun.com/cn-beijing/?tab=globalset#/efm/coding_plan).
- **Benefits**: Higher usage quotas, predictable monthly costs, access to the latest qwen3-coder-plus model.
- **Cost & quota**: View [Alibaba Cloud Bailian Coding Plan documentation](https://bailian.console.aliyun.com/cn-beijing/?tab=doc#/doc/?type=model&url=3005961).

Enter `qwen` in the terminal to launch Qwen Code, then enter the `/auth` command and select `API-KEY`

![](https://gw.alicdn.com/imgextra/i4/O1CN01yXSXc91uYxJxhJXBF_!!6000000006050-2-tps-2372-916.png)

After entering, select `Coding Plan`:

![](https://gw.alicdn.com/imgextra/i4/O1CN01Irk0AD1ebfop69o0r_!!6000000003890-2-tps-2308-830.png)

Enter your `sk-sp-xxxxxxxxx` key, then use the `/model` command to switch between all Bailian `Coding Plan` supported models:

![](https://gw.alicdn.com/imgextra/i4/O1CN01fWArmf1kaCEgSmPln_!!6000000004699-2-tps-2304-1374.png)

**Alternative: configure Coding Plan via `settings.json`**

If you prefer to skip the interactive `/auth` flow, add the following to `~/.qwen/settings.json`:

```json
{
  "modelProviders": {
    "openai": [
      {
        "id": "qwen3-coder-plus",
        "name": "qwen3-coder-plus (Coding Plan)",
        "baseUrl": "https://coding.dashscope.aliyuncs.com/v1",
        "description": "qwen3-coder-plus from Bailian Coding Plan",
        "envKey": "BAILIAN_CODING_PLAN_API_KEY"
      }
    ]
  },
  "env": {
    "BAILIAN_CODING_PLAN_API_KEY": "sk-sp-xxxxxxxxx"
  },
  "security": {
    "auth": {
      "selectedType": "openai"
    }
  },
  "model": {
    "name": "qwen3-coder-plus"
  }
}
```

> [!note]
>
> The Coding Plan uses a dedicated endpoint (`https://coding.dashscope.aliyuncs.com/v1`) that is different from the standard Dashscope endpoint. Make sure to use the correct `baseUrl`.

### Option2: Third-party API-KEY

Use this if you want to connect to third-party providers such as OpenAI, Anthropic, Google, Azure OpenAI, OpenRouter, ModelScope, or a self-hosted endpoint.

The key concept is **Model Providers** (`modelProviders`): Qwen Code supports multiple API protocols, not just OpenAI. You configure which providers and models are available by editing `~/.qwen/settings.json`, then switch between them at runtime with the `/model` command.

#### Supported protocols

| Protocol          | `modelProviders` key | Environment variables                                        | Providers                                                                                           |
| ----------------- | -------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| OpenAI-compatible | `openai`             | `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`          | OpenAI, Azure OpenAI, OpenRouter, ModelScope, Alibaba Cloud Bailian, any OpenAI-compatible endpoint |
| Anthropic         | `anthropic`          | `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL` | Anthropic Claude                                                                                    |
| Google GenAI      | `gemini`             | `GEMINI_API_KEY`, `GEMINI_MODEL`                             | Google Gemini                                                                                       |
| Google Vertex AI  | `vertex-ai`          | `GOOGLE_API_KEY`, `GOOGLE_MODEL`                             | Google Vertex AI                                                                                    |

#### Step 1: Configure models and providers in `~/.qwen/settings.json`

Define which models are available for each protocol. Each model entry requires at minimum an `id` and an `envKey` (the environment variable name that holds your API key).

> [!important]
>
> It is recommended to define `modelProviders` in the user-scope `~/.qwen/settings.json` to avoid merge conflicts between project and user settings.

Edit `~/.qwen/settings.json` (create it if it doesn't exist). You can mix multiple protocols in a single file — here is a multi-provider example showing just the `modelProviders` section:

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
  }
}
```

> [!tip]
>
> Don't forget to also set `env`, `security.auth.selectedType`, and `model.name` alongside `modelProviders` — see the [complete example above](#recommended-one-file-setup-via-settingsjson) for reference.

**`ModelConfig` fields (each entry inside `modelProviders`):**

| Field              | Required | Description                                                          |
| ------------------ | -------- | -------------------------------------------------------------------- |
| `id`               | Yes      | Model ID sent to the API (e.g. `gpt-4o`, `claude-sonnet-4-20250514`) |
| `name`             | No       | Display name in the `/model` picker (defaults to `id`)               |
| `envKey`           | Yes      | Environment variable name for the API key (e.g. `OPENAI_API_KEY`)    |
| `baseUrl`          | No       | API endpoint override (useful for proxies or custom endpoints)       |
| `generationConfig` | No       | Fine-tune `timeout`, `maxRetries`, `samplingParams`, etc.            |

> [!note]
>
> When using the `env` field in `settings.json`, credentials are stored in plain text. For better security, prefer `.env` files or shell `export` — see [Step 2](#step-2-set-environment-variables).

For the full `modelProviders` schema and advanced options like `generationConfig`, `customHeaders`, and `extra_body`, see [Settings Reference → modelProviders](settings.md#modelproviders).

#### Step 2: Set environment variables

Qwen Code reads API keys from environment variables (specified by `envKey` in your model config). There are multiple ways to provide them, listed below from **highest to lowest priority**:

**1. Shell environment / `export` (highest priority)**

Set directly in your shell profile (`~/.zshrc`, `~/.bashrc`, etc.) or inline before launching:

```bash

# Alibaba Dashscope
export DASHSCOPE_API_KEY="sk-..."

# OpenAI / OpenAI-compatible
export OPENAI_API_KEY="sk-..."

# Anthropic
export ANTHROPIC_API_KEY="sk-ant-..."

# Google GenAI
export GEMINI_API_KEY="AIza..."
```

**2. `.env` files**

Qwen Code auto-loads the **first** `.env` file it finds (variables are **not merged** across multiple files). Only variables not already present in `process.env` are loaded.

Search order (from the current directory, walking upward toward `/`):

1. `.qwen/.env` (preferred — keeps Qwen Code variables isolated from other tools)
2. `.env`

If nothing is found, it falls back to your **home directory**:

3. `~/.qwen/.env`
4. `~/.env`

> [!tip]
>
> `.qwen/.env` is recommended over `.env` to avoid conflicts with other tools. Some variables (like `DEBUG` and `DEBUG_MODE`) are excluded from project-level `.env` files to avoid interfering with Qwen Code behavior.

**3. `settings.json` → `env` field (lowest priority)**

You can also define API keys directly in `~/.qwen/settings.json` under the `env` key. These are loaded as the **lowest-priority fallback** — only applied when a variable is not already set by the system environment or `.env` files.

```json
{
  "env": {
    "DASHSCOPE_API_KEY": "sk-...",
    "OPENAI_API_KEY": "sk-...",
    "ANTHROPIC_API_KEY": "sk-ant-..."
  }
}
```

This is the approach used in the [one-file setup example](#recommended-one-file-setup-via-settingsjson) above. It's convenient for keeping everything in one place, but be mindful that `settings.json` may be shared or synced — prefer `.env` files for sensitive secrets.

**Priority summary:**

| Priority    | Source                         | Override behavior                        |
| ----------- | ------------------------------ | ---------------------------------------- |
| 1 (highest) | CLI flags (`--openai-api-key`) | Always wins                              |
| 2           | System env (`export`, inline)  | Overrides `.env` and `settings.env`      |
| 3           | `.env` file                    | Only sets if not in system env           |
| 4 (lowest)  | `settings.json` → `env`        | Only sets if not in system env or `.env` |

#### Step 3: Switch models with `/model`

After launching Qwen Code, use the `/model` command to switch between all configured models. Models are grouped by protocol:

```
/model
```

The picker will show all models from your `modelProviders` configuration, grouped by their protocol (e.g. `openai`, `anthropic`, `gemini`). Your selection is persisted across sessions.

You can also switch models directly with a command-line argument, which is convenient when working across multiple terminals.

```bash
# In one terminal

qwen --model "qwen3-coder-plus"

# In another terminal

qwen --model "qwen3-coder-next"
```

## Security notes

- Don’t commit API keys to version control.
- Prefer `.qwen/.env` for project-local secrets (and keep it out of git).
- Treat your terminal output as sensitive if it prints credentials for verification.
