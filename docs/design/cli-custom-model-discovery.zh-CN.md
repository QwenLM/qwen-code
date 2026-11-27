# CLI 自定义供应商模型发现

[English](cli-custom-model-discovery.md) | [简体中文](cli-custom-model-discovery.zh-CN.md)

## 问题与范围

CLI 已为部分内置预设提供模型发现，但自定义供应商仍须手填 ID。
本次扩展已有向导，不新增配置命令。覆盖新建及通过 `/auth` 重新连接，
不新增后台轮询或已存供应商的批量刷新命令。

## 参考研究

已将 OpenCode 拉取至 `~/github/opencode`，版本为
`367d24b70aec58e7827f04c47dadf2a9f6802053`。
其 `packages/tui/src/component/dialog-integration.tsx` 提供选项、手输、
显式 Continue 与取消；`dialog-model.tsx` 从共享目录读取模型，按供应商
过滤、搜索，并以供应商/模型身份选择。目录可用不等于向上游发现：
`core/src/plugin/models-dev.ts` 提供目录模型，而
`core/src/plugin/provider/modal.ts` 与 `core/src/modal/models.ts`
执行供应商专属的带认证发现，具备超时与连接身份关联的缓存。
这些是参考先例，不能据此声称存在通用自定义端点发现 API。
详细代码链路记录在本地调查报告。

本地供应商共用 `core/src/plugin/provider/local.ts`，提供端点与凭据关联的
缓存、每端点锁、30 秒后台刷新及 15 秒请求超时。vLLM 先检查 `/health`
再查询 `/v1/models`，Ollama 使用 `/api/tags` 与 `/api/show`，LM Studio
使用 `/api/v1/models`。这些专属适配器说明通用发现必须保留失败兜底。

借鉴显式确认、手动兜底，以及候选列表与当前选择的分离；保留 Qwen
键盘习惯与持久化机制，不引入 OpenCode 的插件/缓存架构。

## 设计

复用 core `providers/model-discovery.ts` 的有界请求、解析、ID 校验、
去重及预设元数据保留。增加可选协议，默认保留现有 OpenAI 行为。
Chat Completions 追加 `/models`；Responses 与 Anthropic 归一化末尾
`/v1` 后追加 `/v1/models`。Anthropic 保留版本头并对齐运行时认证：
原生 Anthropic 主机使用 `x-api-key`，代理使用 Bearer 认证。
两种渲染器均在自定义列表不可用时明确提示手动填写。
支持标准 `data` 数组及网关 `models` 映射。保持五秒、一 MiB 上限及
失败返回 null 的约定，兼容现有预设调用者。

复用 `DiscoveringModelIdsStep` 与 `ModelIdsStep`。支持的自定义协议在
填完 URL/key 后进入可取消的加载状态，再展示可搜索、键盘多选及手输的
候选快照。Enter 确认，Esc 返回并中止请求。Gemini 保留手填。
已有安装身份和高级配置仍为准，只有原有确认/保存流程完成后才持久化。

两种渲染器遵守同一约定。OpenTUI 的 `dialogs-auth.tsx` 调用同一个核心
函数，快照完成后交给现有按终端可用区域计算高度的模型选择器。
加载时不挂载编辑器，离开时中止请求并丢弃晚到结果；编辑只在 Enter 时
确认，返回步骤时恢复已确认的选择，未列出的手动 ID 仍可编辑。
内置预设保留发现开关、精选模型和重定向默认值；自定义请求禁止重定向。
原来不支持发现的供应商流程保持现有行为。动态标题、回退提示和键盘提示
均计入终端高度预算。

Web Shell 原型包含 daemon 适配器与设置协调，具有不同信任及归属要求。
此次 CLI 复用核心与向导层，不调用 daemon 路由，不将服务端凭据解析搬入
TUI。后续统一 daemon 适配器时必须保留其公网策略。

## 验收与风险

验证三种协议路径/认证头、网关解析、手输兜底、取消及过期结果隔离。
保留现有预设发现、元数据与 ID 校验测试。用受控本地端点及假凭据测试
键盘选择与实际保存，执行构建、类型检查、打包、定向测试与代码评审。

OpenTUI 组件测试覆盖三种协议、Gemini 手填、加载/取消、晚到结果、搜索、
恢复与取消勾选、丢弃未确认草稿、最终保存，以及内置预设成功和回退。
使用 Bun 和 `QWEN_TUI_RENDERER=opentui QWEN_TUI_RENDERER_STRICT=1`
对隔离的本地端点验证原生渲染器；严格模式防止回退到 Ink 掩盖问题。

交互 CLI 按已有 fetch 策略支持本地 HTTP，不放宽 daemon SSRF 策略。
不新增发现元数据持久化，模型仍使用安装默认值或显式高级配置。
无需迁移设置，不自动切换模型。
