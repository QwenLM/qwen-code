# models.dev 模型目录：动态拉取方案（待审）

日期：2026-09-16
状态：**Draft PR 已开，实现随本文一起提交**。本文列出我做出的每个决策与备选，供评审者逐条推敲；评审结论直接改 PR。
关联：issue #8558（提出需求）、PR #9851（英文设计文档，六层优先级）、#8529（早期只做模态的草案，已关闭）、#9501（qwen3.8-max effort 400 的止血修复）。

结论先行：**按 opencode 的模式做——构建期打一份裁剪后的 models.dev 快照进包，运行时优先读本地缓存，后台每日刷新；查询时目录优先、正则表兜底。** 用户不升级 CLI 也能识别新模型的上下文窗口、输出上限和输入模态。

---

## 1. 问题与目标

现状：三类模型事实都写死在按模型名匹配的正则表里，每出一个新模型都要改代码、发版：

| 事实                              | 现在的位置                                                                | 条目数        |
| --------------------------------- | ------------------------------------------------------------------------- | ------------- |
| 上下文窗口 / 输出上限             | `packages/core/src/core/tokenLimits.ts` 的 `PATTERNS` / `OUTPUT_PATTERNS` | 约 157 条模式 |
| 输入模态（image/pdf/audio/video） | `packages/core/src/core/modalityDefaults.ts` 的 `MODALITY_PATTERNS`       | 约 81 条模式  |
| effort 档位 / 推理开关            | `reasoning-effort.ts`、`dashscope.ts` 等分散判断                          | 本方案不动    |

目标：前两类改为数据驱动，第三类留给设计文档的 PR4。

## 2. 先例（源码级）

| 项目                                              | 做法                                                                                                                                                                                                                                                                                                                                                       | 值得抄的点                               |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| **opencode**（`packages/core/src/models-dev.ts`） | 构建期 `generate.ts` 拉 `api.json` 注入全局常量；运行时：磁盘缓存 → 内置快照 → 都没有才同步走网络；启动后 fork 一个每 60 分钟的刷新任务，缓存 mtime 5 分钟内不重拉；跨进程文件锁 + 临时文件 rename；刷新完发事件热重载 catalog；开关 `OPENCODE_DISABLE_MODELS_FETCH` / `OPENCODE_MODELS_URL` / `OPENCODE_MODELS_PATH`；默认走自家镜像 `models.opencode.ai` | 三层读取顺序、原子写、开关三件套         |
| **Hermes Agent**（`agent/models_dev.py`）         | 内存缓存 4h → 磁盘缓存不限时 → 无缓存才走网络；ETag 条件 GET；stale-while-revalidate；失败退避 5 分钟；损坏缓存隔离；维护 Hermes provider 名 → models.dev id 的别名表                                                                                                                                                                                      | ETag 让刷新几乎免费；provider 别名表     |
| **Crush**（`internal/config/catwalk.go`）         | 自家 catwalk 服务而非 models.dev，但同样：二进制内嵌 → 磁盘缓存 + ETag → 自动更新可关；额外有 `crush update-providers [url\|file\|embedded]` 手动命令                                                                                                                                                                                                      | 手动导入命令（离线环境）                 |
| **pi-mono**（`scripts/generate-models.ts`）       | 只在构建期生成 `models.generated.ts`，运行时不拉；靠大量 override 表修正 models.dev 的错误                                                                                                                                                                                                                                                                 | 反例：仍需发版；但 override 表思路可借鉴 |

## 3. 数据事实（已实测，2026-09-15 UTC）

- `https://models.dev/api.json`：4.6 MB，217 个 provider、7805 个模型，无鉴权，约 0.15 s；**支持 ETag，条件请求返回 304 且 0 字节**。
- `alibaba`（国际站）55 个模型、`alibaba-cn`（国内站）87 个。qwen3.8-max / qwen3.8-flash 已收录，带 `limit`、`modalities`、`reasoning_options`（含 effort 档位 `low/medium/xhigh`、budget 上限、`interleaved.field = reasoning_content`）。
- **全量拍平不可行**：把 217 个 provider 按模型 id 拍平会混入 helicone、poe、cortecs、qiniu-ai 等中转站的错误别名（如 `claude-4.5-sonnet` 输出 8192）。
- **限定 12 个一线厂商后**：237 个唯一（归一化后）模型 id，pretty JSON 约 30 KB。
- 与现有正则表 diff（一线厂商范围内），限制值的分歧全部是 models.dev 更准：

| 模型                             | 现有表           | models.dev                   |
| -------------------------------- | ---------------- | ---------------------------- |
| `qwen-flash` 上下文              | 262,144          | 1,000,000                    |
| `qwen3-coder-plus` 输出          | 32,768           | 65,536                       |
| `qwen3.8-max` 模态               | image            | image, video, pdf            |
| `gpt-5.5` 上下文                 | 272,000          | 922,000（`limit.input`）     |
| `claude-fable-5-1` 上下文 / 输出 | 200,000 / 65,536 | 1,000,000 / 128,000          |
| `claude-sonnet-4-5` 上下文       | 200,000          | 1,000,000（**存疑**，见 §6） |

- 模态互有缺漏：models.dev 给 `qwen-vl-max`、`qwen3-vl-plus` 只标 image，现有表有 image+video；反过来 `qwen3.8-max`、`qwen3.5-27b` 是 models.dev 更全。

## 4. 方案

### 4.1 数据形状（拍平、裁剪）

```json
{
  "source": "https://models.dev/api.json",
  "fetchedAt": "2026-09-15T15:55:07.958Z",
  "etag": "\"4dbc...\"",
  "models": {
    "qwen3.8-max": {
      "context": 1000000,
      "output": 131072,
      "modalities": { "image": true, "pdf": true, "video": true }
    },
    "qwen3-coder-plus": { "context": 1048576, "output": 65536 }
  }
}
```

- key = 现有 `normalize()` 归一化后的模型 id（去 provider 前缀、变体标签、日期后缀），与正则表看到的是同一个字符串。
- `context = limit.input ?? limit.context`（gpt-5 得 272,000，与现有表的"输入上限"语义一致）；0 值当作缺失。
- `modalities` 直接存 `InputModalities` 对象，只存 `true` 的键。
- 只保留三个字段；`reasoning` / `reasoning_options` 暂不存（无消费者，避免"死字段"）。
- 内置快照与运行时缓存**共用同一投影函数**，一个 loader。

### 4.2 provider 白名单与冲突规则

```
anthropic, openai, google, deepseek, moonshotai, zai, minimax, xai,
alibaba-cn, alibaba, modelscope, volcengine
```

- 厂商在前、DashScope 在后：Qwen 只在 alibaba\* 下，自然取 alibaba-cn；GLM/DeepSeek/MiniMax/Kimi 取厂商自家数值（与现有正则表的取向一致，例如 deepseek-v4 的 1M/384K 就是厂商值）。
- 同一 key 出现多次：**"自身即归一化形式"的精确 id 胜过被折叠的别名**（`qwen3-max` 胜 `qwen3-max-20260123`）；都是别名时 `release_date` 最新者胜；其余先到先得。
- 排除 openrouter / requesty 等路由商（它们的 id 带 `vendor/` 前缀，归一化后会与厂商条目撞 key，且上限是路由商自己的）。

### 4.3 读取顺序与优先级

对每个字段单独回退（最高优先在前）：

1. 用户 `modelProviders` / settings 显式配置（现状不变，`modelConfigResolver.ts` 已是最高）
2. 运行时缓存 `~/.qwen/model-registry.json` —— **仅当 `fetchedAt` 比内置快照新**（升级 CLI 后不会被旧缓存压住）
3. 内置快照 `packages/core/src/models/generated/model-registry.json`
4. 现有正则表
5. 通用默认值

- 上下文 / 输出上限：目录优先，字段缺失才落到正则。
- **模态：目录与正则取并集**（两边都只会"声明支持"，spread 即并集）。目录只能增能力、不能删能力，保证"今天能附图的模型明天不会不能附"。代价：表里错误开启的模态目录关不掉，只能靠用户配置。
- 目录未收录的模型：行为与今天完全一致。
- 读取是一次 `readFileSync` + JSON.parse，模块级懒加载，不阻塞启动。

### 4.4 刷新

- 触发点：`Config.initializeInternal()` 里 `await this.proxyDispatcherReady` 之后 `void refreshModelCatalog()` —— 全局代理 dispatcher 已装好，`fetch` 自动走代理；所有入口（TUI、headless、ACP、serve、daemon）都经过这里。
- 节流：缓存 `fetchedAt` 在 24 h 内直接返回；否则带 `If-None-Match` 请求，304 只更新 `fetchedAt`，200 则裁剪、原子写（`atomicWriteJSON`）、使内存目录失效。
- 10 s 超时；任何失败只打 debug 日志。进程内并发调用共享一个 in-flight promise。
- 不做跨进程锁：原子 rename 保证不会写坏，多进程同时刷新只是多一次请求。
- 环境变量：
  - `QWEN_CODE_MODELS_DEV=off`：整个目录关闭，回到纯正则（也是单元测试 setup 的默认值，见 §5）。
  - `QWEN_CODE_MODELS_DEV_REFRESH=off`：不联网，只用内置快照（内网 / 代理受限；集成测试设置它保持 CI 无外网依赖）。
  - `QWEN_CODE_MODELS_DEV_URL`：镜像地址（国内访问 models.dev 可能不稳定，这一项比想象中重要）。
- **用户自定义目录 `model.customCatalog`**（用户提出的离线场景）：URL 或本地文件路径，内容按模型逐字段叠加在 models.dev 目录之上（第 4.3 节的第 2/3 层之上、用户显式配置之下）。接受 models.dev `api.json` 格式（取文件里全部 provider）或精简格式 `{"models":{"<id>":{...}}}`（key 会归一化）。本地文件在每次启动时同步读取并物化到 `~/.qwen/model-registry.custom.json`，首个会话即生效；URL 与 models.dev 同节奏（24 h + ETag）下载到同一缓存，且**不受 `QWEN_CODE_MODELS_DEV_REFRESH=off` 影响**（内网用户正是关掉 models.dev、只拉内网地址）。缓存文件记录 `source`，设置改变或移除后旧缓存自动失效。
- 刷新成功后的新数值在**下次模型解析**时生效（`contextWindowSize` 在 Config 初始化时解析），即下次启动或切换模型；不做 opencode 那种事件热重载。

### 4.5 构建期快照

- `npm run generate:model-catalog [-- <url-or-file>]` → `scripts/generate-model-catalog.ts`（tsx 运行，与 `generate:settings-schema` 同款），复用同一投影函数，断言 200 KB 体积预算，输出 pretty JSON 便于 diff。
- `**/generated` 已被 prettier / eslint 忽略；`copy_files.js` 会把 `.json` 拷进 dist；esbuild 原生支持 JSON import；`with { type: 'json' }` 写法 cli 里已有先例。
- 定期自动刷新快照的 workflow（周期性开 PR）留作后续。

### 4.6 涉及文件

| 文件                                                        | 改动                                                                                                                                                  |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/models/model-catalog.ts`                 | 新增：类型、缓存路径、`parseModelCatalog`、`loadModelCatalog`（缓存 vs 内置选择）、`lookupModelCatalog(normalizedId)`、`invalidateModelCatalog`、开关 |
| `packages/core/src/models/model-catalog-refresh.ts`         | 新增：provider 白名单、`trimModelsDevCatalog`、`refreshModelCatalog`                                                                                  |
| `packages/core/src/models/generated/model-registry.json`    | 新增：内置快照（237 模型，30 KB）                                                                                                                     |
| `scripts/generate-model-catalog.ts` + `package.json`        | 新增生成脚本与 npm script                                                                                                                             |
| `packages/core/src/core/tokenLimits.ts`                     | `findTokenLimit` / `hasExplicitOutputLimit` 先查目录                                                                                                  |
| `packages/core/src/core/modalityDefaults.ts`                | `defaultModalities` 与目录取并集                                                                                                                      |
| `packages/core/src/config/config.ts`                        | 初始化时触发刷新（1 行 + 1 个 import）                                                                                                                |
| `packages/core/test-setup.ts`、`packages/cli/test-setup.ts` | 默认 `QWEN_CODE_MODELS_DEV=off`                                                                                                                       |
| `integration-tests/test-helper.ts`                          | `QWEN_CODE_MODELS_DEV_REFRESH=off`                                                                                                                    |
| `docs/users/configuration/settings.md`                      | 环境变量表加 3 行                                                                                                                                     |
| 新增 / 扩展测试                                             | `model-catalog.test.ts`、`model-catalog-refresh.test.ts`、`tokenLimits.test.ts`、`modalityDefaults.test.ts`                                           |

依赖方向：`core/tokenLimits.ts → models/model-catalog.ts`（不反向引用，`lookup` 接收已归一化的 id 以避免循环）；`models/model-catalog-refresh.ts → core/tokenLimits.ts`（用 `normalize`）；`config/config.ts → models/model-catalog-refresh.ts`。`core/*` 引用 `../models/` 已有先例（`contentGenerator.ts`、`reasoning-effort.ts`）。

## 5. 测试策略（需要评审的点）

**问题**：一线厂商范围内 237 个 id 里有 235 个的上限值与现有正则表不同，而现有测试大量断言正则表的数值（`tokenLimits.test.ts`、`modelConfigResolver.test.ts`、`modelRegistry.test.ts`、`acpAgent.test.ts` 等）。本机不能跑测试，盲改几十处断言风险高。

**当前选择**：测试 setup 里默认 `QWEN_CODE_MODELS_DEV=off`，既有断言原样保留；目录本身的行为由新测试（fixture + `vi.mock`）覆盖。代价：绝大多数测试在"目录关闭"下运行，不检验真实优先级。

备选：把受影响断言全部改成 models.dev 的值（测试与快照内容耦合，每次重生成都可能崩）；或让 `tokenLimits` 测试用真实快照只断言"目录命中的模型取目录值"这一性质。

## 6. 我不确定、希望评审重点推敲的决策

1. **拍平 vs 按 provider 作用域查询**。拍平最简单、文件最小，但 DashScope 托管的 GLM/DeepSeek/MiniMax 会取厂商值而非 DashScope 值（例如 `glm-5` 输出 131072 vs alibaba-cn 的 16384）。按 baseUrl 映射到 models.dev provider 更准，但要维护 qwen-code 认证类型/预设 → models.dev provider 的别名表（Hermes 的做法），且 `modelConfigResolver` 需要把 baseUrl 传进来。设计文档 #9851 说先 YAGNI。
2. **`claude-sonnet-4-5/4-6/5` 的 1M 上下文**。models.dev 标 1M，但 Anthropic 早期的 1M 需要 beta header；若 API 默认仍是 200K，1M 会让压缩阈值算错、撞 400。现有 `CLAUDE_OPUS_EXTENDED` 只放开 Opus。可能需要一张小 override 表，或对 anthropic 条目做特殊处理。
3. **模态取并集**是否合适，还是应该"目录优先、缺失回落正则"再配 override 表修 `qwen-vl-*` 的 video 缺漏（设计文档原意）。
4. **`normalize()` 的折叠副作用**：`deepseek-v3.2` 会折叠成 `deepseek`，与 alibaba-cn 的某个 deepseek 条目撞 key（现在取 163840/65536，今天正则给 128K/默认）。折叠是 normalize 的既有行为，但目录把它显性化了。
5. **`qwen3.8-max` 的 pdf**：models.dev 声称支持；qwen-code 的 DashScope PDF 路径是否真的能发，未验证。
6. **刷新间隔 24 h**（设计文档值）vs opencode 60 min。有了 ETag 之后缩短几乎没有成本；但更短意味着更多进程启动时的后台请求。
7. **触发点放在 core 的 `Config.initializeInternal`** 还是 CLI 入口。放 core 覆盖所有入口，但意味着任何构造并初始化 Config 的进程（包括第三方用 core 的）都会有一次后台联网。
8. **是否需要跨进程锁**（opencode 有）。`qwen serve` / agent team 会并发启动多个进程。
9. **缓存位置** `~/.qwen/model-registry.json`（`Storage.getGlobalQwenDir()`，遵守 `QWEN_HOME`）vs `getRuntimeBaseDir()`（遵守 `QWEN_RUNTIME_DIR`）。
10. 是否**顺手把 `reasoning_options` 存进快照**：models.dev 现在对 qwen3.8 系列有 effort 档位数据，设计文档写的"effort 档位必须 qwen-code 自维护"这条已经不成立。但接入 DashScope 的钳制属于 PR4，我这次没动。
11. **`model.customCatalog` 的合并语义**：目前是"逐模型、逐字段覆盖"，且自定义文件的 `modalities` 对象整体替换目录里的（用户可以用 `{}` 把目录多标的模态关掉，但关不掉正则表里的）。是否需要更细的字段级删除语义？另外自定义源目前只做用户级（`~/.qwen`），不做项目级。
12. 设计文档 #9851 只有英文版，AGENTS.md 要求中英同步，这个 PR 是否要顺带补 zh-CN。

## 7. 当前状态与下一步

- §4.6 的全部文件随本文档在同一个 Draft PR 中提交；快照用线上数据生成（237 模型、29,824 字节）。
- 本地已做：prettier（`--experimental-cli`）、eslint（`--max-warnings 0`）、生成脚本跑通、tsx 冒烟（目录开 / 关两种取值）。
- 本地未做：typecheck、单元测试、集成测试（本机不跑），以 CI 为准。
- 下一步：按 §6 的评审结论调整实现，在同一 PR 上追加提交，不另开 PR。
