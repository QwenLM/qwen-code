# Telemetry: Daemon 会话的 channel 归因

> 配套 issue: [#8660](https://github.com/QwenLM/qwen-code/issues/8660)
> 基于 2026-08-07 对 qwen-code main 分支的代码复核

## 1. 背景

默认 usage-statistics（qwen-logger RUM）载荷中只有一个入口维度 `properties.channel`，它来自 `--channel` 标志：

- VS Code 伴生插件直接启动 `qwen --acp --channel=VSCode`
- Electron 桌面端直接启动 `qwen --acp --channel=desktop`
- TS/Python/Java SDK 的主入口（`query()`）直接 spawn CLI（stream-json 模式），自带 `--channel=SDK`
- `--acp` 未显式指定 channel 时回退为 `ACP`（`packages/cli/src/config/config.ts` 的 ACP fallback）

但 `qwen serve`（daemon）的 spawn 工厂启动的是不带 channel 的 `qwen --acp` 子进程（`packages/acp-bridge/src/spawnChannel.ts`），因此**经 daemon 承载的会话——SDK 的 daemon 客户端入口（如 TS SDK 的 `DaemonClient`/`DaemonSessionClient`）、Web Shell、Tauri 桌面 shell——全部上报为 `ACP`**，无法区分。Tauri shell 启动 daemon 时设置了 `QWEN_CODE_DESKTOP=1`（`packages/desktop-shell/src-tauri/src/runtime.rs`），但 telemetry 从未读取该变量。

`app.channel` 是来自 `~/.qwen/source.json` 的**安装来源**，与入口归因是不同概念，不应被重载。

## 2. 方案

复用现有 `properties.channel` 维度，不新增 payload 键。`getChannel()` 经复核没有任何行为消费方（只有 telemetry 读取），channel 是纯上报维度，扩展其取值无副作用。

daemon 在每个子进程环境中设置 `QWEN_CODE_SERVE=1` 标记，覆盖两个 spawn 点：

- `packages/acp-bridge/src/spawnChannel.ts`（ACP 会话子进程）
- `packages/cli/src/serve/channel-worker-supervisor.ts`（channel worker；worker 内 `channels/base/AcpBridge.ts` 通过 `{...process.env}` 继续继承该标记）

CLI 的 ACP channel 回退（`packages/cli/src/config/acp-channel-fallback.ts`）按标记解析：

| 条件                  | channel 取值                                                    |
| --------------------- | --------------------------------------------------------------- |
| 显式 `--channel=X`    | `X`（不变，显式参数优先）                                       |
| `QWEN_CODE_DESKTOP=1` | `desktop`（Tauri shell 会话，与 Electron 桌面端同一客户端身份） |
| `QWEN_CODE_SERVE=1`   | `daemon`（daemon 承载的会话）                                   |
| 其余                  | `ACP`（直接三方 ACP 启动，不变）                                |

归因矩阵：

| 场景                                              | properties.channel           |
| ------------------------------------------------- | ---------------------------- |
| 交互/无头 CLI                                     | （无）                       |
| 三方直接 ACP                                      | `ACP`                        |
| VS Code 伴生                                      | `VSCode`                     |
| Electron 桌面端（直连，不走 daemon）              | `desktop`                    |
| SDK `query()` 直连（TS/Python/Java，不走 daemon） | `SDK`（SDK 自带，不变）      |
| daemon 会话（SDK daemon 客户端、Web Shell 等）    | `daemon`                     |
| daemon 会话（Tauri desktop shell）                | `desktop`                    |
| docker/podman sandbox 内的 daemon 会话            | 继承外层 `daemon`/`desktop`  |
| daemon channel worker                             | worker 名（如 feishu，不变） |

## 3. 为什么 daemon 会话不能像 VS Code 那样直接传 `--channel`

VS Code 伴生插件**自己拥有 spawn**：一个客户端 = 一个专属子进程，所以能传 `--channel=VSCode`。

daemon 的桥接模型不同（`packages/acp-bridge/src/bridge.ts`）：**一个 bridge（一个 workspace）至多一个 `qwen --acp` 子进程**，所有客户端的会话经 `connection.newSession()` 多路复用到同一个进程上，共享进程/OAuth/FileReadCache。因此：

- spawn 时不知道哪个客户端会连进来（子进程可能预热）；
- 同一进程内同时跑着不同客户端的会话，进程级参数无法表达会话级身份；
- qwen-logger payload 是进程级构造，进程级 channel 无法按会话区分客户端。

环境标记 + 回退解析因此是当前模型下唯一的进程级归因手段。

## 4. Schema 影响与兼容性

- 零新增键。`properties.channel` 仅新增一个可能取值：`daemon`（`desktop` 是既有取值，Tauri shell 会话并入其中）。
- `app.channel` 语义与取值不变；显式 `--channel` 的既有取值（`VSCode`/`desktop`/`SDK`/worker 名）不变。
- `QWEN_CODE_SERVE` 为信息性标记，不含敏感信息；不进入 `SCRUBBED_CHILD_ENV_KEYS`（denylist 语义不受影响）。
- docker/podman sandbox 会显式透传 `QWEN_CODE_SERVE` / `QWEN_CODE_DESKTOP`，避免 sandbox 内子进程退回 `ACP`；项目 `.env`/`settings.env` 不能设置这两个标记，避免 workspace 伪造客户端归因。

## 5. 后续工作（不在本次范围）

按 SDK/Web Shell 细分客户端需要**会话级**归因：各客户端在创建会话时经由 daemon 自我声明，现有 `qwen.session.source` meta → `config.setSessionSource(sourceType, sourceId)` 管道（#8155 为生命周期钩子引入）是自然的扩展点。当前 Web Shell 主会话仅使用 `sourceType: 'default'`。由于默认 payload 是进程级的，会话级身份落到 telemetry 还需要会话维度的支持，届时再决定是否引入独立的 client 键。
