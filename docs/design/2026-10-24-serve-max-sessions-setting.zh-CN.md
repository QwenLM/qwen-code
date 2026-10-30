# 在 `settings.json` 中持久化 `max-sessions`

[English](2026-10-24-serve-max-sessions-setting.md) | [简体中文](2026-10-24-serve-max-sessions-setting.zh-CN.md)

## 问题

`qwen serve --max-sessions` 只能从命令行传入。因此每次重启 daemon 都要重复这个
flag；没有启动脚本的部署（一次性的 `nohup` 命令行、手工拼装的容器 entrypoint）
会悄悄退回内置上限 32。`serve` 设置区块已经能持久化 `serve.channels`、
`serve.tokenQr` 和子会话并发上限，却唯独没有运维最常需要调整的单 workspace
会话上限。

## 现状

- `packages/cli/src/commands/serve.ts` 给 `--max-sessions` 声明了
  `default: 32`，所以 yargs 结果分不清"没传 flag"和"传了 32"。
- `runQwenServe` 把该值传给每个 workspace runtime；注册多个 workspace 时，
  `deriveDefaultMaxTotalSessions` 还用它推导 daemon 级总上限。
- `serve.tokenQr` 是现有先例：flag 不设默认值，值在 daemon 启动时从 fast-path
  settings 摘要解析，且只允许 operator 作用域设置。

## 目标与非目标

目标：

- 允许 `settings.json` 中的 `serve.maxSessions` 设置单 workspace 上限。
- 保持 `--max-sessions` 为最高优先级来源。
- 阻止 workspace settings 文件抬高 daemon 级资源上限。
- 非法值要报告，而不是静默关闭背压。

非目标：

- 持久化其他 serve 上限（`max-total-sessions`、`max-connections`、
  `event-ring-size` 等）。每一项都需要单独评审优先级与作用域。
- 修改内置默认值 32。

## 方案

解析顺序：`--max-sessions` → `serve.maxSessions` → `32`。

1. 移除 yargs 选项的 `default: 32`，让未传的 flag 保持 `undefined`；有效默认值
   仍写在描述和文档里。
2. serve fast-path 读取器只从 user、system、system-defaults 作用域挑选
   `serve.maxSessions`。workspace 文件设置了该键时，通过
   `ignoredWorkspaceKeys` 上报，且绝不采用其值。
3. 把 `serve.maxSessions` 注册进 `WORKSPACE_RESTRICTED_SETTINGS`，让完整
   settings 加载器剥离 workspace 值、发出警告，并让设置对话框按作用域过滤。
4. daemon 启动时，若 `opts.maxSessions` 仍为 `undefined`，在创建 bridge 之前、
   调用 `deriveDefaultMaxTotalSessions` 之前，从
   `bootSettings.serve.maxSessions` 解析。
5. 接受非负整数或 `Infinity`；`0` 表示关闭上限。其他值在 stderr 上报告并按
   未设置处理。
6. 在 Web Shell 设置面板中暴露该设置：把 `serve.maxSessions` 加入 daemon 的
   `WEB_SHELL_SETTINGS` 允许列表（它是 `showInDialog: false`，不在对话框允许
   列表中），并在 Web Shell 客户端发布展示别名。面板可在用户作用域读写；
   workspace 作用域写入仍返回现有的 `workspace_restricted_setting` 拒绝。

## 设计决策

- **在启动阶段解析，而不是 yargs handler。** daemon 存在不经过命令 handler 的
  fast path，`serve.tokenQr` 正是为此从 `bootSettings` 解析。单一解析点保证两条
  路径行为一致。
- **仅 operator 作用域。** 该上限约束单 workspace 的内存与文件描述符。克隆下来
  的仓库不得抬高它，这与已应用于 `serve.maxConcurrentSubSessions*` 的规则一致。
- **非法值警告并回退。** bridge 本身会对 `NaN` 和负数抛错。把手改坏的 settings
  文件复用成启动失败会让 daemon 直接退出；回退默认值既保留现有上限，又点名拼写
  错误。这与子会话上限读取器一致。
- **默认值保持可见。** 移除 yargs 默认值不能改变对外声明：
  `advertisedMaxSessions(undefined)` 本来就返回 `32`，schema 保留
  `default: 32` 供编辑器和 `/settings` 使用。

## 风险

- 依赖 shell 补全显示默认值的运维会发现该默认值不再出现在 flag 上；描述里仍写明
  默认值。
- workspace 值会被忽略。启动路径在 stderr 上报告被丢弃的键，行为可见而非静默。
- schema 中的 `serve.maxSessions` 默认值必须与 `acp-bridge` 和
  `serve-features.ts` 中的 `DEFAULT_MAX_SESSIONS` 保持同步。

## 验证

- 单元测试：fast-path 作用域选择与合并优先级；非法值处理；传/不传 flag 的
  yargs 解析。
- `cd packages/cli && npx vitest run src/serve/fast-path.test.ts
src/serve/run-qwen-serve.test.ts src/commands/serve.test.ts
src/config/settingsSchema.test.ts`
- `npm run typecheck` 与 `npm run lint`。

## 验收标准

- 用户 settings 设置 `serve.maxSessions: 64` 且不传 flag 时，`qwen serve`
  对外声明并执行 64。
- flag 与 setting 同时存在时，flag 生效。
- 只有 workspace `.qwen/settings.json` 设置该项时，daemon 使用默认 32，并记录
  被忽略的键。
- 设置 `serve.maxSessions: -1` 时，daemon 以默认值启动并警告。
- Web Shell 设置面板在“高级”分类下显示该行，保存后显示重启徽标；workspace
  作用域写入返回现有的限制错误。
- 其他 serve 上限不变；多 workspace 总上限推导除使用解析后的单 workspace 值外
  没有其他变化。
