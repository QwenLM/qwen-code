# OpenRouter OAuth 接入设计总结

> 本文总结 qwen-code 中 OpenRouter OAuth 的接入背景、架构决策、实现细节、踩坑记录与验证方式。目标是让未来开发者在不了解上下文的前提下，也能快速理解这条链路的来龙去脉，并安全地继续演进。

## 1. 背景

在本轮改造之前，qwen-code 的认证体系已经支持：

- Qwen OAuth
- Alibaba Cloud Coding Plan
- OpenAI-compatible provider（通过 `AuthType.USE_OPENAI` + `modelProviders.openai`）

而 OpenRouter 在运行时其实已经有一部分能力：

- core 中已存在 OpenRouter provider 适配：
  - `packages/core/src/core/openaiContentGenerator/provider/openrouter.ts`
- 可以识别 `openrouter.ai` base URL
- 会自动注入 OpenRouter 所需 headers：
  - `HTTP-Referer: https://github.com/QwenLM/qwen-code.git`
  - `X-OpenRouter-Title: Qwen Code`

所以这次设计的核心不是“从零新增一个平台”，而是：

> 把 OpenRouter 作为现有 OpenAI-compatible provider 机制的一条认证路径接入 CLI 与 TUI。

---

## 2. 核心设计决策

### 2.1 不新增 `AuthType`

最终没有新增 `AuthType.OPENROUTER`，而是复用：

- `AuthType.USE_OPENAI`
- `modelProviders.openai`

原因：

1. **架构上更自然**：OpenRouter 对 qwen-code 来说本质上就是 OpenAI-compatible provider
2. **减少改动面**：避免 auth status、model resolution、provider selection、settings schema 再扩一层分支
3. **更符合现有 runtime 事实**：core 已经是按 OpenAI-compatible provider 机制消费 OpenRouter

因此，OpenRouter 配置落盘后的最终状态是：

- `security.auth.selectedType = openai`
- `modelProviders.openai = [...]`
- `env.OPENROUTER_API_KEY = <key>`
- `model.name = <某个 OpenRouter model id>`

### 2.2 不把 OpenRouter 当成“纯手填 key”功能

实现上同时支持两条路径：

- `qwen auth openrouter --key <...>`：手动 API key
- `qwen auth openrouter`：浏览器 OAuth
- `/auth -> API Key -> OpenRouter`：TUI 内浏览器 OAuth

这样一来：

- 自动化场景可以直接塞 key
- 普通用户可以用浏览器走官方授权

### 2.3 OpenRouter 模型列表动态拉取，但保留 fallback

认证成功后会尝试拉取：

- `GET https://openrouter.ai/api/v1/models`

并将结果映射进 `modelProviders.openai`。

如果请求失败，则 fallback 到一组默认模型，避免认证流程整体失败。

---

## 3. OpenRouter OAuth 目标链路

目标链路如下：

```text
用户触发认证
  ↓
打开浏览器到 OpenRouter 授权页
  ↓
用户完成授权
  ↓
OpenRouter 重定向到本地 callback
  http://localhost:3000/openrouter/callback?code=...
  ↓
CLI/TUI 本地 listener 收到 code
  ↓
POST /api/v1/auth/keys 交换 API key
  ↓
写入 settings/env/modelProviders
  ↓
refreshAuth(AuthType.USE_OPENAI)
  ↓
认证完成
```

这条链路最终由 `packages/cli/src/commands/auth/openrouterOAuth.ts` 负责。

---

## 4. OpenRouter OAuth API 约定

在实践中确认的接口如下：

- authorize URL:
  - `https://openrouter.ai/auth`
- exchange endpoint:
  - `POST https://openrouter.ai/api/v1/auth/keys`
- callback URL:
  - `http://localhost:3000/openrouter/callback`
- PKCE method:
  - `S256`

### 4.1 callback host 的一个关键结论

最初尝试的是：

- `http://127.0.0.1:3000/openrouter/callback`

但实际手测发现，OpenRouter 浏览器跳回时使用的是：

- `http://localhost:3000/openrouter/callback`

因此后续实现与测试全部统一使用 `localhost`，否则会出现浏览器实际回调地址与本地 listener 不一致的问题。

### 4.2 `Key label (optional)` 当前不可由 qwen-code 预填

在 OpenRouter 授权页弹窗中，当前会看到一个：

- `Key label (optional)`

其默认值常见为：

- `An app`

这部分 UI 是 OpenRouter 托管页面的一部分，不是 qwen-code 本地渲染的表单。

根据 OpenRouter 官方 TypeScript OAuth 文档，当前文档化的授权相关字段只有：

- `callbackUrl`
- `codeChallenge`
- `codeChallengeMethod`
- `limit`

以及 code exchange 阶段的：

- `code`
- `codeChallengeMethod`
- `codeVerifier`

文档中没有出现以下这类可用于预填 key label 的字段：

- `keyLabel`
- `label`
- `name`
- `defaultLabel`

因此截至本文撰写时，可以认为：

> OpenRouter 授权页中的 `Key label (optional)` 默认值当前不是 qwen-code 可控项。

即使 qwen-code 侧已经发送了品牌相关信息，例如：

- `HTTP-Referer`
- `X-OpenRouter-Title: Qwen Code`

也不能据此推断 OpenRouter 会用它来填充 `Key label`。

如果未来 OpenRouter 官方文档新增了相关参数，再考虑在授权 URL 构造阶段接入。

---

## 5. 文件结构与职责

### 5.1 认证核心

| 文件                                                     | 作用                                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `packages/cli/src/commands/auth/openrouterOAuth.ts`      | OpenRouter PKCE、callback listener、code -> key exchange、动态模型拉取、merge helper |
| `packages/cli/src/commands/auth/handler.ts`              | `qwen auth openrouter` CLI 路径                                                      |
| `packages/cli/src/commands/auth/openrouter.test.ts`      | CLI OpenRouter auth 测试                                                             |
| `packages/cli/src/commands/auth/openrouterOAuth.test.ts` | OAuth helper / listener / model fetch 测试                                           |
| `packages/cli/src/commands/auth/status.test.ts`          | auth status 中 OpenRouter 的测试                                                     |

### 5.2 TUI `/auth` 接入

| 文件                                                      | 作用                                                     |
| --------------------------------------------------------- | -------------------------------------------------------- |
| `packages/cli/src/ui/auth/AuthDialog.tsx`                 | `/auth` 对话框，提供 OpenRouter 入口                     |
| `packages/cli/src/ui/auth/useAuth.ts`                     | `/auth` 的行为实现，负责触发 OpenRouter OAuth 并落盘配置 |
| `packages/cli/src/ui/contexts/UIActionsContext.tsx`       | 暴露 `handleOpenRouterSubmit()`                          |
| `packages/cli/src/ui/AppContainer.tsx`                    | 将 auth hook state/actions 接入 UIState/UIActions        |
| `packages/cli/src/ui/components/DialogManager.tsx`        | 根据认证状态切换显示 AuthDialog / OAuth progress         |
| `packages/cli/src/ui/components/ExternalAuthProgress.tsx` | OpenRouter 这类外部 OAuth 的 loading 视图                |
| `packages/cli/src/ui/auth/AuthDialog.test.tsx`            | `/auth` 入口测试                                         |
| `packages/cli/src/ui/auth/useAuth.test.ts`                | `/auth` auth state 测试                                  |
| `packages/cli/src/ui/AppContainer.test.tsx`               | UI 状态接线测试                                          |

---

## 6. 配置落盘约定

OpenRouter OAuth 成功后，当前实现会写入：

```json
{
  "env": {
    "OPENROUTER_API_KEY": "..."
  },
  "modelProviders": {
    "openai": [
      {
        "id": "...",
        "name": "OpenRouter · ...",
        "baseUrl": "https://openrouter.ai/api/v1",
        "envKey": "OPENROUTER_API_KEY"
      }
    ]
  },
  "security": {
    "auth": {
      "selectedType": "openai"
    }
  },
  "model": {
    "name": "openai/gpt-4o-mini"
  }
}
```

其中：

- `OPENROUTER_API_KEY` 是环境变量 key
- OpenRouter provider 统一使用 `baseUrl = https://openrouter.ai/api/v1`
- 认证类型保持 `openai`

---

## 7. 动态模型列表设计

### 7.1 拉取方式

认证完成后调用：

- `GET https://openrouter.ai/api/v1/models`

并将返回结果映射为 `ModelConfig[]`。

### 7.2 映射规则

当前保留的字段相对克制：

- `id`
- `name`
- `baseUrl`
- `envKey`
- `capabilities.vision`（当输入 modality 包含 `image`）
- `generationConfig.contextWindowSize`（来自 `context_length`）

### 7.3 不写 `description`

实践中发现，如果把 OpenRouter 原始 `description` 带进模型列表，后续 `/model` 等展示会太长，因此当前**刻意不写** `description`。

### 7.4 过滤规则

只保留可用于当前 CLI 主流程的模型：

- 必须有 `id`
- 如果 `output_modalities` 存在，则必须包含 `text`

也就是说，纯图片输出模型会被过滤掉。

### 7.5 排序规则

为了更符合中文用户和国内模型偏好，动态模型列表做了稳定排序，优先：

1. `qwen/`
2. `glm/`
3. `minimax/`
4. 其它模型按 `id` 字母序

### 7.6 fallback 模型

如果动态拉取失败，则回退到当前 hardcoded defaults：

- `openai/gpt-4o-mini`
- `anthropic/claude-3.7-sonnet`
- `google/gemini-2.5-flash`

这样即使 OpenRouter models 接口异常，认证流程仍可完成。

---

## 8. `/auth` 对话框接入设计

最开始，CLI 路径已经支持 OpenRouter，但 `/auth` 对话框并没有真正接入它。

修复后，`/auth` 入口变成：

```text
/auth
  → API Key
    → OpenRouter
```

对应行为：

1. 用户在 AuthDialog 里选择 OpenRouter
2. `useAuth.ts` 中的 `handleOpenRouterSubmit()` 被触发
3. 关闭 AuthDialog
4. 切换到显式 loading 视图
5. 完成 OAuth / key exchange / model fetch / refreshAuth
6. 成功后退出 loading，并写入 history 提示

---

## 9. 认证中 UI 设计

### 9.1 为什么需要单独的 loading 视图

最开始 `/auth` 的问题有两个极端：

1. **对话框一直不消失**：用户浏览器里已经授权成功，但 terminal 里还停在 `/auth`
2. **过早恢复输入**：虽然对话框关了，但实际上 key 还没下发完成，用户却已经能继续输入

最终确定的正确语义是：

> 浏览器授权完成 ≠ CLI 已完成认证。

因此在 `/auth` 路径中引入了显式 loading 视图 `ExternalAuthProgress`：

- `Waiting for OpenRouter callback...`
- `OpenRouter authorization complete. Requesting API key...`
- `Syncing OpenRouter models and finalizing local configuration.`

并在 loading 期间禁止输入，直到真正认证完成。

### 9.2 状态表达

`useAuth.ts` 中新增了 `externalAuthState`，用于承载 OpenRouter 这类外部 OAuth 的中间态；
`DialogManager.tsx` 则根据：

- `isAuthenticating`
- `pendingAuthType`
- `externalAuthState`

决定渲染对应的 progress view。

---

## 10. 本轮排查出的关键坑

这部分是本文最重要的“经验总结”。未来如果有人再接入新的浏览器 OAuth，强烈建议先看这里。

### 10.1 坑一：callback host 不一致

**现象**：浏览器打开正常，但 CLI 一直等不到 callback。

**原因**：OpenRouter 实际跳回 `localhost`，而不是 `127.0.0.1`。

**修复**：所有实现与测试统一改为：

- `http://localhost:3000/openrouter/callback`

---

### 10.2 坑二：浏览器 callback 页面已经成功，但 CLI 仍卡很久

**现象**：浏览器已经显示：

```text
OpenRouter authentication complete.
You can return to Qwen Code.
```

但 CLI 端仍然要等几十秒。

**根因**：`startOAuthCallbackListener()` 收到 `code` 后，先等待：

- `server.close()`

等 server 真正关闭后，才 resolve `waitForCode`。

而 `server.close()` 的 callback 触发条件是：

> 所有现有连接都结束

浏览器的 keep-alive 连接会让这个关闭过程拖很久，于是形成“浏览器早就成功了，CLI 却还在等”的假象。

**修复**：listener 收到 `code` 后：

1. 先 `resolveCode(code)`
2. 再后台异步 `close()`

也就是：

> 主流程先继续，server 收尾不能阻塞 OAuth。

---

### 10.3 坑三：即使 listener 已经先 resolve，`runOpenRouterOAuthLogin()` 还是慢

**现象**：更细粒度 timing 显示：

- `Waited for browser authorization`: 比如 17s
- `Exchanged auth code for API key`: 比如 1s
- 但 `OpenRouter OAuth callback completed`: 却仍然高达 70~90s

**根因**：`runOpenRouterOAuthLogin()` 的 `finally` 中还有：

```ts
await listener.close();
```

虽然 listener 已经先把 `code` resolve 给主流程了，但函数返回前仍然被 `finally` 卡住。

**修复**：

```ts
void listener.close().catch(() => undefined);
```

即 fire-and-forget，不再让 `finally` 阻塞函数返回。

---

### 10.4 坑四：callback timing 最初把“用户在浏览器里的操作时间”也算进去了

最开始看到：

- `OpenRouter OAuth callback completed in 39s`

这条信息容易让人误以为“OpenRouter 下发 key 很慢”。

但进一步打点后发现，这一段其实混合了：

- 用户在浏览器页面里停留多久
- OpenRouter 回调回来多久
- `auth/keys` 换 key 多久

所以后来又把 timing 拆细成：

- `Waited for OpenRouter browser authorization in ...`
- `Exchanged OpenRouter auth code for API key in ...`
- `OpenRouter OAuth callback completed in ...`

这能更精确地判断瓶颈到底在“人等待”还是“服务端慢”。

---

## 11. timing 打点结论

实际打点后，本轮最重要的经验是：

- `GET /api/v1/models` 很快，常见在 1 秒内
- `config.refreshAuth(AuthType.USE_OPENAI)` 很快
- `POST /api/v1/auth/keys` 也不慢，通常 1 秒左右
- 体感中的“很慢”很多时候其实是：
  - 用户在浏览器里停留时间
  - callback listener/close 的错误阻塞方式

换句话说：

> 认证链路真正容易出问题的，往往不是业务接口本身，而是本地 callback listener 的状态机和 server 收尾顺序。

这是以后再做 OAuth 接入时最值得记住的一点。

---

## 12. 验证方式

### 12.1 定向单测

主要测试文件：

```bash
cd packages/cli
npm run test -- --run \
  src/commands/auth/openrouterOAuth.test.ts \
  src/commands/auth/openrouter.test.ts \
  src/commands/auth/status.test.ts \
  src/ui/auth/useAuth.test.ts \
  src/ui/auth/AuthDialog.test.tsx \
  src/ui/AppContainer.test.tsx
```

本轮最终相关定向测试通过数为：

- 6 个测试文件
- 79 个测试

### 12.2 手动验证

建议至少手动验证两条路径：

#### CLI

```bash
npm run build && npm run bundle
node dist/cli.js auth openrouter
```

#### TUI

```bash
npm run dev
/auth
```

重点观察：

- 浏览器是否能打开 OpenRouter 授权页
- callback 是否落到 `http://localhost:3000/openrouter/callback`
- terminal 中 timing 是否合理
- 成功后是否能正确展示 auth status

### 12.3 黑盒确认

认证完成后，建议跑：

```bash
node dist/cli.js auth status
```

预期看到：

- Authentication Method: OpenRouter
- Current Model: `openai/gpt-4o-mini`（或将来被切到别的默认模型）
- Status: API key configured

---

## 13. 未来开发者最需要知道的修改入口

如果未来要继续改 OpenRouter 相关能力，优先看这几个点：

### 13.1 改 OAuth 行为

看：

- `packages/cli/src/commands/auth/openrouterOAuth.ts`

这里集中承载：

- PKCE
- callback listener
- auth code exchange
- dynamic model fetch
- merge helper
- OAuth timing

### 13.2 改 CLI `qwen auth openrouter`

看：

- `packages/cli/src/commands/auth/handler.ts`

### 13.3 改 `/auth` 交互体验

看：

- `packages/cli/src/ui/auth/useAuth.ts`
- `packages/cli/src/ui/auth/AuthDialog.tsx`
- `packages/cli/src/ui/components/DialogManager.tsx`
- `packages/cli/src/ui/components/ExternalAuthProgress.tsx`

### 13.4 改模型列表策略

看：

- `fetchOpenRouterModels()`
- `toOpenRouterModelConfig()`
- `mergeOpenRouterConfigs()`

---

## 14. 当前已知的后续可选优化

### 14.1 默认模型选择仍是固定值

目前落盘默认模型仍是：

- `openai/gpt-4o-mini`

即使动态模型列表已经成功拉取，也没有自动改成“动态列表里的首个可用模型”。

这是刻意保持保守，但未来可以考虑进一步优化。

### 14.2 模型优先级可以继续扩展

当前只对以下前缀做优先：

- `qwen/`
- `glm/`
- `minimax/`

未来如有需要，可以扩展到：

- `zhipu/`
- `deepseek/`
- `moonshotai/`
- `stepfun/`
- `baidu/`

但要注意：

- 排序规则应稳定
- 不要和 provider 原始顺序耦合过深
- 尽量保持简单易理解

### 14.3 成功文案还可以更贴近真实阶段

目前 loading 和 history 提示已经比最初清晰很多，但如果未来再做 UX 优化，建议继续坚持一个原则：

> 明确区分“等待用户在浏览器授权”和“CLI 正在完成本地配置”。

这比笼统地写成 `callback completed` 更能减少误解。

---

## 15. 总结

本轮 OpenRouter OAuth 接入的经验可以浓缩成四句话：

1. **OpenRouter 不需要新 auth type，复用 `AuthType.USE_OPENAI` 即可。**
2. **浏览器 OAuth 接入最难的不是接口本身，而是本地 callback listener 的状态机。**
3. **如果 callback 页面已经成功，但 CLI 还在卡，优先怀疑 `server.close()` / `finally` 收尾阻塞。**
4. **想搞清楚 OAuth 慢在哪，必须拆 timing，而不是只看一个总时间。**

如果未来再接入别的第三方 OAuth，建议直接复用这套思路：

- 先设计清楚配置落盘语义
- 再设计 callback listener 的生命周期
- 最后用细粒度 timing 验证“到底慢在哪”

这样能少踩很多坑。
