# `qwen serve` REST API 解耦方案（场景 A：独立进程 + REST）

**日期**：2026-09-08
**背景**：外部团队希望以 Qwen Code 为底座接入，但不需要 WebShell UI，只需要一套可对接的 HTTP REST API。
**场景**：A —— 合作方独立起一个 daemon 进程，通过 REST 对接。**不是**嵌入式库，**不是**多租户平台。

---

## 1. 现状盘点

### 1.1 WebShell 其实已经可拆

| 事实                                                                    | 位置                                     |
| ----------------------------------------------------------------------- | ---------------------------------------- |
| `--no-web` 已存在，flag 描述就是 "Use --no-web for an API-only daemon." | `packages/cli/src/commands/serve.ts:274` |
| 找不到 web-shell 构建产物时自动降级为 API-only，不崩                    | `serve/web-shell-resolver.ts`            |
| `--cli-only` 构建本来就不打 web-shell                                   | `scripts/build.js:38`                    |

**结论：「不要 WebShell」零改动即可满足。** 本方案不需要在这上面花任何工作量。

### 1.2 真正的缺口

**缺口一 —— 没有对外的嵌入/复用出口。**
`serve/index.ts` 已经是一个相当完整的 barrel（导出 `createServeApp` / `runQwenServe` / 全套错误类型），注释里甚至明写了 _"External embeds that want to recognize these errors…"_。但 `packages/cli/package.json` 的 `exports` 只开了 `.` 和 `./export` —— **意图有了，出口没开**。

**缺口二 —— API 语义面是给 WebShell 设计的，不是给合作方设计的。**

- `SERVE_CAPABILITY_REGISTRY` 有 **125 个 feature tag**（`serve/capabilities.ts`）
- 路由字面量抓到 **110 条左右**，分布在 `serve/routes/*.ts` 的约 **65 个注册点**

其中绝大多数是 WebShell 的驱动面：`/workspace/git/*`、`/workspaces/:w/github/prs`、`/workspace/extensions`（含 install）、`/workspace/skills`、`/live/*`、`/workspace/voice`、cdp-tunnel、channel-webhooks、scheduled-tasks、`/usage/dashboard`。

合作方真正需要的只是其中一小撮：**建会话 → 发 prompt → 流式收事件 → 回权限请求 → 读工作区上下文**。

这不只是"接口太多不好懂"的问题，是**最小权限问题**：现在所有路由共享同一个 bearer token，持有 token 就能调 `/workspace/trust`（改信任策略）、`/workspace/extensions/install`（装扩展）、`/workspace/git/push`（推代码）、`/workspace/settings`（改配置）。对一个只想跑 prompt 的合作方来说，这个授权面过宽。

**缺口三 —— 没有机器可读的接口契约。**
`docs/developers/qwen-serve-protocol.md` 有 3032 行，写得很细，但是散文。合作方要生成客户端、要写 mock、要在 CI 里做契约校验，都需要 OpenAPI。仓库里目前没有任何 OpenAPI / Swagger 文件。

### 1.3 一个必须说清楚的事实：daemon 依赖 CLI 可执行文件

http-bridge 模式下，daemon 不是自己跑推理，而是 **spawn `qwen --acp` 子进程**（`packages/acp-bridge/src/spawnChannel.ts`，`MissingCliEntryError`）。`--http-bridge` 的 flag 描述里写着 Stage 2 的进程内模式 _"is not yet implemented"_。

所以：**即使把 server 抽成独立包，运行时仍然需要 CLI 可执行文件在 PATH 上。** 这不是缺陷（进程隔离 = 崩溃隔离 + 内存隔离），但合作方的容器镜像里躲不掉，必须在对接文档里讲明。

---

## 2. 目标与非目标

### 目标

1. 合作方拿到一个**明确、稳定、可生成客户端**的 REST 子集，而不是 110 条路由的全集。
2. 该子集可以在部署时**真正收窄**，让 token 泄漏的爆炸半径限定在会话操作内。
3. 提供**嵌入出口**，让合作方能在自己的 Node 进程里复用（即使场景 A 主要用独立进程，这个出口成本极低）。
4. 对现有 WebShell **零行为影响**。

### 非目标

- **抽出 `packages/serve` 独立包**。场景 A 用不上（合作方起的是进程，不是 import 一个包）。可行性调研结论记录在 §6 备查。
- **多租户 / 多用户模型**。经与用户确认，不是本次重点。真要做的方向是"一租户一实例"外层编排，不是改 daemon 的信任模型。
- **Stage 2 进程内模式**。与本方案正交。

---

## 3. 实施方案

### 第 0 步：先用现成的东西对接（0 改动）

```bash
qwen serve --no-web --require-auth --token "$QWEN_SERVER_TOKEN" \
           --hostname 0.0.0.0 --port 4170 --workspace /srv/project
```

配合 `docs/developers/qwen-serve-protocol.md` 和 TS / Python / Java SDK。

**这一步的真正价值是逼出需求**：让合作方先跑起来，回答"你们到底调哪几条路由"。这个答案决定了 §3.2 的 `minimal` 白名单该收到多紧。**白名单的初版按下面 §3.2 的清单落地，后续按合作方反馈调整。**

### 第 1 步：开放 `./serve` 子路径导出

`packages/cli/package.json` 的 `exports` 增加：

```json
"./serve": {
  "types": "./dist/src/serve/index.d.ts",
  "import": "./dist/src/serve/index.js"
}
```

零风险 —— `serve/index.ts` 早已是设计好的公共 barrel，构建产物路径与已有的 `./export` 条目同构。

### 第 2 步：API profile —— 一个闸门，不是 65 个 `if`

**实现方式（关键设计决策）**：不在 65 个 `registerXxxRoutes` 调用点上包 `if`。那会产生一个巨大的 diff、与活跃分支高冲突、且每加一条路由都要记得改。

改为**在 `bearerAuth` 之后插一个中间件闸门**：路径不在当前 profile 白名单里的，一律 404。

```
allowOriginCors → hostAllowlist → rateLimiter → accessLog
  → [webShell assets / channel webhooks / loopback /health]   ← 闸门管不到，见下
  → authenticate（原 bearerAuth）
  → apiProfileGate(profile)        ← 新增，唯一插入点
  → jsonBodyParser → ...65 个注册点原封不动...
```

- **`full`（默认）**：不安装闸门，行为与今天逐字节相同。
- **`minimal`**：只放行 §3.2 的白名单。

放在认证中间件 `authenticate` **之后**是有意的：未认证请求先拿 401，无法通过 404/401 的差异枚举出哪些路由被启用了。

**闸门管不到的三处，以及为什么可以不管：**

| 前置于 bearerAuth 的挂载 | 为什么不用管                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| WebShell 静态资源        | 合作方本来就跑 `--no-web`，`webShellDir` 为 `undefined` 时根本不挂载                               |
| channel webhooks         | 仅在 `deps.enqueueChannelWebhookTask` 存在时挂载，需要配置 channel worker；合作方不会配            |
| loopback 上的 `/health`  | 仅在"loopback 且无 `--require-auth`"时前置于认证。`/health` 本来就在白名单里，所以放不放行结果一样 |

**匹配粒度：按路径，不按方法。** `/file`（读）与 `/file/write`、`/file/edit`（写）本来就是不同路径，路径粒度足够表达"只读文件"。这省掉了一整套 method × path 的匹配逻辑，代价是像 `/workspace/settings` 这种 GET 安全、PATCH 危险的路径只能整条排除 —— 方向是保守的，可接受。

### 3.2 `minimal` 白名单

原则：**会话生命周期 + prompt + 流式 + 权限回执 + 只读工作区上下文**。

| 路径                                              | 用途               |
| ------------------------------------------------- | ------------------ |
| `/health`                                         | 存活探针           |
| `/capabilities`                                   | 预检               |
| `/session`                                        | 建会话             |
| `/session/:id`                                    | 删会话             |
| `/session/:id/prompt`                             | 发 prompt          |
| `/session/:id/cancel`                             | 中断               |
| `/session/:id/events`                             | SSE 事件流         |
| `/session/:id/status`                             | 会话状态           |
| `/session/:id/transcript`                         | 对话记录           |
| `/session/:id/context`                            | 上下文用量         |
| `/session/:id/export`                             | 导出               |
| `/session/:id/pending-prompts`                    | 排队中的 prompt    |
| `/session/:id/heartbeat`                          | 保活               |
| `/session/:id/metadata`                           | 会话元数据         |
| `/session/:id/model`                              | 选模型             |
| `/session/:id/load`、`/session/:id/resume`        | 恢复会话           |
| `/session/:id/permission/:requestId`              | 权限回执（会话内） |
| `/permission/:requestId`                          | 权限回执（全局）   |
| `/workspace/tools`                                | 工具清单（只读）   |
| `/file`、`/file/bytes`、`/stat`、`/list`、`/glob` | 工作区只读文件访问 |

**被排除的高风险面**（合作方拿到 token 也调不动）：`/workspace/trust`、`/workspace/settings`、`/workspace/extensions*`、`/workspace/git/push|pull`、`/workspace/github/*`、`/workspace/channel*`、`/live/*`、`/workspace/voice`、`/workspace/generate`、`/workspace/init`、`/workspace/reload`、`/scheduled-tasks`、`/goals`、`/usage/dashboard`、`/workspace-registrations`。

### 3.3 `/capabilities` 要诚实

`minimal` 下，125 个 tag 里有一大半对应的路由已经 404 了。这**违反了 `docs/developers/daemon/11-capabilities-versioning.md` 里的核心不变量**："tag present means behavior present"。

处理方式（选了最诚实、最省的那个）：

- `/capabilities` 响应体增加 `apiProfile: 'full' | 'minimal'` 字段。
- 在 11-capabilities-versioning.md 里**显式写明这个不变量的豁免**：当 `apiProfile === 'minimal'` 时，tag 不再蕴含路由可达，OpenAPI spec 才是权威。

不加 feature tag —— 加了就和这个字段重复。也不做 125 个 tag 到路由的逐一映射 —— 那是几百行只为让一个字段更精确，不划算。

### 第 3 步：OpenAPI spec

`docs/developers/qwen-serve-openapi.yaml`，**覆盖范围恰好等于 `minimal` profile**。

这个对齐是有意的，两个交付物互相加强：

> **`minimal` profile == OpenAPI 描述的、承诺稳定性的对外契约面。**
> `full` 的其余部分是 WebShell 内部面，不进 spec，不承诺稳定。

并加一个**双向漂移守卫测试**：spec 里的每条路径都必须被 `minimal` 放行，`minimal` 里的每条路径都必须出现在 spec 里。仓库里已有同形状的先例可以照抄 —— `serve/server/telemetry-catalog.test.ts` 用的就是"实例化 express app → 遍历 `app.router.stack` → 与目录双向比对"。YAML 解析用已有依赖 `yaml`，不引新包。

### 第 4 步：对接文档

`docs/developers/rest-api-integration.md` —— 给合作方的落地指南：启动命令、认证、最小会话流程（建会话 → prompt → SSE → 权限回执）、§1.3 的 CLI 子进程依赖、profile 与 spec 的关系。

---

## 4. 交付物清单

| #   | 交付物                                              | 类型 |
| --- | --------------------------------------------------- | ---- |
| 1   | `packages/cli/package.json` 增加 `./serve` 导出     | 改动 |
| 2   | `serve/api-profile.ts`（白名单 + 闸门中间件）       | 新增 |
| 3   | `serve/server.ts` 插入闸门（单点）                  | 改动 |
| 4   | `serve/types.ts` 增加 `apiProfile`                  | 改动 |
| 5   | `commands/serve.ts` 增加 `--api-profile`            | 改动 |
| 6   | `/capabilities` 增加 `apiProfile` 字段              | 改动 |
| 7   | `docs/developers/qwen-serve-openapi.yaml`           | 新增 |
| 8   | `serve/api-profile.test.ts` 双向漂移守卫            | 新增 |
| 9   | `docs/developers/rest-api-integration.md`           | 新增 |
| 10  | `daemon/11-capabilities-versioning.md` 补不变量豁免 | 改动 |

---

## 5. 已知取舍

- **闸门不省启动开销。** 路由照常全部注册，`minimal` 只是不让它们被访问到。目标是收窄授权面和契约面，不是加快启动。真要省启动开销得走第 65 个 `if` 的路子，不值得。
- **白名单要手工同步。** 新增一条对外路由时要记得加进白名单和 spec。§3.3 的双向漂移守卫会在 spec 与白名单脱节时报错，但**它不会发现"新加的路由两边都没写"**。这是有意的取舍：全量路由目录的守卫成本远高于收益。
- **`/demo` 已不存在。** 规划时把它列为闸门管不到的风险点，但落地到 `origin/main` 时发现上游已经删掉了 `serve/demo.ts`，健康检查也从 `healthDemoRoutes` 改名为 `healthRoutes`。这条风险自动消失，实现里不需要为它做任何事。
- **路径粒度而非方法粒度**，见 §3.1 末尾。

---

## 6. 备查：`packages/serve` 抽包可行性（本次不做）

本次不做，但调研结论值得记下来，将来真要抽包不用重新查：

serve 目录 **172 个非测试文件 / 94136 行**。跨包边界的依赖出乎意料地薄：

- **只有 3 个非测试文件** import `../ui/`：`live/qwen-realtime-session.ts`、`voice/voice-ws.ts`、`server/session-export.ts`（都在 voice / live / export 上）
- 其余跨界依赖高度集中：`utils/stdioHelpers.js` 54 处、`config/settings.js` 38 处、`config/trustedFolders.js` 13 处、`runtime/channel-delivery-ipc.js` 12 处

把这四个下沉到 core 或一个新的 `serve-runtime` 包，`packages/serve` 就能独立出去。真正的动力应该是**场景 B（嵌入式库）**出现时 —— 那时合作方 import `@qwen-code/qwen-code` 会吞下 ink / react / 9 个 channel 包的依赖树，才是非解不可的问题。

---

## 7. 验证

本机不跑 build / typecheck / test（内存受限，见项目约定），全部交给 CI。PR 里会写明哪些没有本地验证过。

需要 CI 确认的点：

1. `Lint & Static` —— 新增文件的 eslint / prettier / 许可证头
2. `Test (ubuntu-latest)` —— `serve/api-profile.test.ts` 双向漂移守卫通过
3. `server.test.ts` 现有用例不因闸门插入而回归（`full` 默认下闸门不安装，预期零影响）
4. `integration-tests/cli/qwen-serve-routes.test.ts` 保持通过
