# 在 settings.json 中配置 verify-pr 的发布坐标

[English](verify-pr-assets-config.md) | [简体中文](verify-pr-assets-config.zh-CN.md)

Status: implementing with this change.

## 问题

维护者手动执行 `/verify-pr <n> --publish` 时，会把截图发布到 assets 分支，并在 PR 评论里引用。分支已经能按 flag、环境变量、`assets/pr<n>-validation` 依次解析，但**图床仓库**仍要每轮确认。一个在轮次之间从不变化的坐标，应当只需配置一次。

## 现状

- skill 只解析分支，仓库这一项仅以"发布前确认图床"的形式出现。
- `settings.json` 对项目级 skill 没有传值通道：`skills.*` 只有启用/禁用列表，未知 key 会被丢弃并打印 `Unknown setting '<key>' will be ignored in <path>`。
- `settings.env` 可以供出 skill 读取的变量，但环境加载器会合并**所有**作用域（含 workspace），只排除 storage/loader 类键。于是一个被 clone 下来的仓库可以设置 `QWEN_VERIFY_ASSETS_REPO`，把维护者的验证证据重定向到别处。

## 方案

- 新增 `verifyPr.assetsRepo` 与 `verifyPr.assetsBranch`，只认 User / System / SystemDefaults 作用域。
- 把 `verifyPr` 列入 workspace 受限根设置：合并期剥离 workspace 值、告警说明其被忽略。设置路由本就不把这些键暴露给 workspace 写入，因此真正保护取值的是剥离而不是路由守卫。
- 把 `QWEN_VERIFY_ASSETS_REPO` 与 `QWEN_VERIFY_ASSETS_BRANCH` 加入"项目 `.env` / `settings.env` 不得提供"的排除集。两者都由仓库控制，而环境加载器先于 settings 桥接执行；若不排除，仓库仍可通过自己 export 变量重定向目标。启动环境、home 作用域 `.env` 与 `verifyPr.*` 仍可设置它们。
- 启动时 CLI 在这两个变量未被设置的前提下，把它们写入 `QWEN_VERIFY_ASSETS_REPO` / `QWEN_VERIFY_ASSETS_BRANCH`；skill 继续读它已经文档化的变量，一次性的 export 仍然优先。
- skill 明确三级顺序——flag、变量（export / `.env` / settings）、默认值——并保持发布同意按次给出。

## 设计决策

1. **独立命名空间，而不是 `settings.env`。** 这两个值决定证据发布到哪里，workspace 作用域不能决定这件事；只有独立命名空间能把"仅 operator 作用域"的约束集中在一处表达。
2. **环境变量桥接，而不是把设置注入 skill 提示。** skill 正文只替换 `{{cliVersion}}` 与 `{{model}}`，项目级 skill 没有设置通道。变量本来就是 skill 文档里的那一级，填变量只需要一个函数，而不是新增一条管线。
3. **flag 仍然最高。** 单轮覆盖必须压过长期配置，已设置的变量必须压过 settings.json——这正是解析器"仅在未设置时填充"的语义。

## 约束与风险

- 写在 workspace 设置里的值不会生效。这是设计目的，但必须可见：schema 描述与 skill 都写明，避免维护者去排查一个被静默忽略的键。
- 通过 `settings.env` 设置这两个变量在任何作用域都不生效（含 User），并在 stderr 明确提示改用 `verifyPr.*` 或启动环境。合并后的 map 无法区分 workspace 条目与 operator 条目，所以只能采用"不区分作用域"这一条可审计的规则；用户级通道是专用设置，`~/.qwen/.env` 仍然可用。
- 桥接位于 `loadSettings` 应用环境的位置。跳过环境加载的调用方都是按请求读取配置，不需要它。
- 坐标不是同意：`--publish` 仍然门控每条评论，发布前 guard 与发布后回读均不变。

## 验证计划

- 解析器单测：未设置、已预置、空 export、空白值、去空格。
- scripts 断言：skill 文档写明 settings 这一级。
- 手动：在 user 作用域设好两项，启动会话确认变量存在，并确认 `/verify-pr <n> --publish` 不带任何 `--assets-*` flag 也能发布到该图床。

## 验收标准

- user 作用域设好两项后，发布轮次不需要 assets flag。
- 同样的键写在 workspace 文件里不产生任何影响。
- 已 export 的变量压过配置值。
- 空 export 不阻塞配置值。

## 待定问题

本范围内没有。把同样的限制推广到其他 skill 坐标属另一项改动。
