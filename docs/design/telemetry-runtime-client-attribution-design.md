# Telemetry: Runtime × Client Attribution in the Default Usage-Statistics Payload

> 配套 issue: [#8660](https://github.com/QwenLM/qwen-code/issues/8660)
> 基于 2026-08-07 对 qwen-code main 分支的代码复核

## 1. 背景

默认 usage-statistics（qwen-logger RUM）载荷中只有一个入口维度 `properties.channel`，它来自 `--channel` 标志：

- VS Code 伴生插件直接启动 `qwen --acp --channel=VSCode`
- Electron 桌面端直接启动 `qwen --acp --channel=desktop`
- `--acp` 未显式指定 channel 时回退为 `ACP`（`packages/cli/src/config/config.ts` 的 ACP fallback）

但 `qwen serve`（daemon）的 spawn 工厂启动的是不带 channel 的 `qwen --acp` 子进程（`packages/acp-bridge/src/spawnChannel.ts`），因此 **SDK（TS/Python/Java）、Web Shell、Tauri 桌面 shell 的会话全部上报为 `ACP`**，无法区分。Tauri shell 启动 daemon 时设置了 `QWEN_CODE_DESKTOP=1`（`packages/desktop-shell/src-tauri/src/runtime.rs`），但 telemetry 从未读取该变量。

`app.channel` 是来自 `~/.qwen/source.json` 的**安装来源**，与运行时/客户端是不同概念，不应被重载。

## 2. 方案

在 `createRumPayload()` 的 `properties` 中新增两个稳定维度（纯增量，不改动 `properties.channel` 与 `app.channel`）：

| 属性      | 取值                                                 | 含义                                               |
| --------- | ---------------------------------------------------- | -------------------------------------------------- |
| `runtime` | `cli` \| `acp` \| `daemon`                           | 执行运行时：交互/无头 CLI、直接 ACP、daemon 子进程 |
| `client`  | `vscode` \| `desktop` \| `desktop-shell`，未知时省略 | 发起方第一方客户端                                 |

判定逻辑集中在 `packages/core/src/telemetry/qwen-logger/runtime-attribution.ts`：

- **daemon**：daemon 在每个子进程环境中设置 `QWEN_CODE_SERVE=1` 标记。两个 spawn 点：
  - `packages/acp-bridge/src/spawnChannel.ts`（ACP 会话子进程）
  - `packages/cli/src/serve/channel-worker-supervisor.ts`（channel worker；worker 内 `channels/base/AcpBridge.ts` 通过 `{...process.env}` 继续继承该标记）
    `qwen --acp` 子进程无法从命令行区分 daemon 启动与三方直接 ACP 启动，环境标记是唯一可靠信号。daemon 标记优先于 channel 启发式（daemon 会话的 channel 恰好回退为 `ACP`）。
- **acp**：非 daemon 但存在 channel 值（含 `ACP` 回退、`VSCode`、`desktop`）。
- **cli**：既无 daemon 标记也无 channel。
- **client**：`--channel=VSCode` → `vscode`；`--channel=desktop` → `desktop`；`QWEN_CODE_DESKTOP=1` → `desktop-shell`（Tauri shell 启动 daemon 时设置，子进程继承——该变量不在 `SCRUBBED_CHILD_ENV_KEYS` 中）。

归因矩阵：

| 场景                       | properties.channel | runtime  | client          |
| -------------------------- | ------------------ | -------- | --------------- |
| 交互/无头 CLI              | （无）             | `cli`    | （省略）        |
| 三方直接 ACP               | `ACP`              | `acp`    | （省略）        |
| VS Code 伴生               | `VSCode`           | `acp`    | `vscode`        |
| Electron 桌面端            | `desktop`          | `acp`    | `desktop`       |
| daemon 会话（SDK 等）      | `ACP`              | `daemon` | （省略）        |
| daemon 会话（Tauri shell） | `ACP`              | `daemon` | `desktop-shell` |
| daemon channel worker      | channel 名         | `daemon` | （省略）        |

## 3. Schema 影响与兼容性

- 纯增量：新增 `properties.runtime`（始终存在）与 `properties.client`（仅已知时存在）。
- `properties.channel`、`app.channel` 语义与取值不变，现有 `VSCode` 区分保留。
- `QWEN_CODE_SERVE` 为信息性标记，不含敏感信息；不进入 `SCRUBBED_CHILD_ENV_KEYS`（denylist 语义不受影响）。

## 4. 后续工作（不在本次范围）

按 SDK/Web Shell 细分 client 需要各客户端经由 daemon 自我声明：daemon 已有 `qwen.session.source` meta → `config.setSessionSource(sourceType, sourceId)` 管道（#8155 为生命周期钩子引入），当前 Web Shell 主会话仅使用 `sourceType: 'default'`。待客户端声明就位后，可将已知 `sourceType` 映射进 `client`，无需再改载荷 schema。
