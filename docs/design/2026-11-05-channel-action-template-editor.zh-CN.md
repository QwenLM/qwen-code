# 渠道动作模板编辑器易用性改进

[English](2026-11-05-channel-action-template-editor.md) | [简体中文](2026-11-05-channel-action-template-editor.zh-CN.md)

状态：已实现并本地验证（2026-11-05）；待提交 PR

## 问题

Web Shell 渠道编辑器把 `record` 类配置字段渲染成「描述符里每个选项一行
label + 单行输入框」。GitHub 渠道的 `boundSessionActions` 字段在描述符里
枚举了完整的封闭键词汇：`default` + 4 个 watch 事件 + 15 个通知 reason =
20 个键，每个键再带 3 个绑定角色前缀（`review:`、`verify:`、`fix:`）——
一个对话框里 **80 行**。而 operator 通常只配置其中一两个键。由此产生三个
易用性缺口：

1. **内容太多。** 无论是否配置，80 行全部渲染，而对话框内容区高度上限只有
   `min(66vh, 650px)`。
2. **没有说明。** 字段只有一段密集文字（键语法、角色路由、7 个模板变量挤在
   一起）；每个键本身没有解释；单行 `Input` 也装不下最长 2,000 码点的指令
   模板（adapter 的 `BOUND_ACTION_TEMPLATE_MAX_CODE_POINTS`）。
3. **不支持全屏。** `ChannelEditorDialog` 固定 `sm:max-w-xl`（约 576px），
   没有展开能力，而其它界面（DialogShell、artifact 面板）已有全屏。

修复上述问题时还会暴露两个相邻缺口：`boundSessionActions` 渲染在
Credentials 分区，而不是紧挨其前置条件 `deliverToBoundSessions` 的绑定会话
面板；绑定投递关闭时仍能填写模板，直到保存才被 daemon 拒绝。

## 现状

- 描述符：`packages/channels/github/src/index.ts` 用 `PR_WATCH_EVENTS`、
  `PR_NOTIFICATION_REASONS`、`PR_BINDING_ROLES` 构建
  `BOUND_ACTION_KEY_OPTIONS`，保证 UI 选项与 adapter 键校验器不会漂移。
- 渲染器：
  `packages/web-shell/client/components/channels/ChannelEditorDialog.tsx`
  的通用 `record` 分支把每个选项映射成 `Label` + `Input` 行。清空某行会从
  draft 删除该键，因为渲染器没有其它删除入口。
- Draft 形态：`draft.values[field.key]` 是 JSON 字符串；
  `channel-editor-state.ts` 的 `parseRouteRecord` 在保存时过滤空值，
  `recordHasRoute` 驱动必填校验。
- 选项形态：`{ value: string; label: string }`，在
  `packages/channels/base/src/types.ts` 与
  `packages/sdk-typescript/src/daemon/types.ts` 两处镜像；cli 的
  `channel-descriptor-sdk-mirror.test.ts` 用类型级镜像测试保证两者一致。
  wire-shape 断言只钉字段级键名。
- GitLab 的 `action_prompt_template` 是唯一的另一个 `record` 字段
  （9 个选项、必填、label 自带说明）。
- i18n：`packages/web-shell/client/i18n.tsx` 持有 `EN` / `ZH` 字典；
  record 选项 label 已经走
  `channels.editor.field.<type>.<field>.option.<value>` 翻译并回退到描述符
  label。`common.fullscreen` / `common.exitFullscreen` 已存在。

## 目标

- 只显示已配置的模板；通过带逐键说明的选择器按需添加键。
- 用多行文本框编辑模板。
- 每个键都有一句中英文说明。
- 渠道编辑对话框支持全屏。
- 保持 draft/保存契约、校验器词汇不变；GitLab record 字段除新 UI 形态外
  行为不变。

## 范围边界

- 不改 adapter 的键词汇、校验、路由、模板变量替换。
- 不改 draft 表示（JSON 字符串）与保存序列化器。
- 全屏只加在 `ChannelEditorDialog`，不动共享 `ui/dialog` 原语。
- 不做可搜索 combobox；80 个键用分组 Select 足够。

## 方案

### 1. 选项元数据（channel-base + SDK 镜像）

在两处镜像类型定义（base 与 enum 形态，每包两处）的选项对象上增加两个
可选字段：

- `description?: string` —— 键的一句话含义，显示在选择器和已配置行里。
- `group?: string` —— 选择器分组标识；同组选项渲染在一个带标题的分区下。

两者均为可选的增量字段，现有插件无需改动即可编译。只改一侧会被镜像类型
测试拦下。registry 的 management 元数据校验不剥离选项键名，catalog 路由
原样透传字段，因此无需改 daemon 路由。

### 2. GitHub 描述符内容

`BOUND_ACTION_KEY_OPTIONS` 的每个选项增加：

- `description`：20 条基础文案（default 回退、4 个 watch 迁移、15 个通知
  reason）。角色限定键复用其基础事件的描述；角色含义由分组标题承载。
- `group`：20 个无前缀键为 `'any'`，其余为角色名。

`default` 选项的 label 改为纯键名；原「fallback for any unmatched event」
措辞移入 description。字段描述重写得更短：模板用途、键形态、绑定投递前置
条件、一句话角色扇出、变量列表、`%%` 转义、留空即默认。

### 3. 通用 record 渲染器（ChannelEditorDialog）

- **按需成行。** 只为 draft record 中存在的键渲染行，包括描述符未枚举的键
  （已存数据保持可见、可编辑、可删除——绝不静默丢弃）。每行：代码样式的
  键名、一行说明、删除图标按钮、值的 `Textarea`。
- **添加选择器。** 行下方的 `Select` 只列未配置的选项，设置 `group` 时用
  `SelectGroup` / `SelectLabel` 分组。选项显示 label + 描述。选中后以空值
  插入该键并重置选择器。
- **编辑期允许空值。** 新添加或清空的行在 draft 中保留键与空值；显式删除
  按钮才移除键。保存序列化器本就过滤空值（`parseRouteRecord`），空条目
  到不了 daemon。这取代旧的「清空即删除」规则，相应注释同步更新。
- **投递门控。** GitHub `boundSessionActions` 在
  `deliverToBoundSessions` 关闭时禁用添加选择器，并用 hint 指明前置条件——
  与 `prWatchEvents` 同一模式。已有行保持可编辑、可删除，关闭投递不会把
  键困住。
- **位置。** `boundSessionActions` 加入 `BOUND_SESSION_FIELD_KEYS`，渲染进
  绑定会话面板，紧挨其前置条件。
- **空态。** 没有任何行时显示一行弱化文案：尚未配置条目。文案用通用的
  「条目」措辞，因为渲染器与非模板类 record 字段（消息路由）共享；GitHub
  与 GitLab 的模板字段通过各自字段 label 键覆盖为「模板」措辞，添加选择器
  占位符同理。

行/选择器项的描述解析顺序：翻译键 `...optionDescription.<value>`，否则
描述符 `option.description`，否则在与键名不同时取翻译后的选项 label
（GitLab 自带说明的 label 因此原样可用）。

### 4. 全屏（仅 ChannelEditorDialog）

标题栏切换按钮（Expand/Shrink 图标、`common.fullscreen` /
`common.exitFullscreen` 文案、`aria-pressed`）在当前尺寸与
`calc(100vw - 2rem)` × `calc(100vh - 2rem)` 之间切换。全屏时内容区改为
flex 纵向布局，body 解除 `min(66vh, 650px)` 上限并占满剩余高度。状态在
对话框打开时随其它每开必重置的状态一起复位。

### 5. i18n

- 重写 `boundSessionActions` 描述（EN + ZH）。
- 20 个基础键的 zh-CN `...boundSessionActions.optionDescription.<key>`
  文案。60 个角色限定条目在 `i18n.tsx` 里由基础条目生成（文案相同，角色由
  分组标题承载），字典保持可维护。英文无需登记：渲染器回退到描述符自带的
  选项描述，保持单一事实源。
- 分组标题 `...boundSessionActions.group.<any|review|verify|fix>`
  （EN + ZH），各注明角色职责。
- record 编辑器界面文案：通用的添加选择器占位与空态行（用「条目」措辞，
  因渲染器与非模板类 record 字段共享）、GitHub 与 GitLab 字段的「模板」
  措辞覆盖、删除按钮 aria-label、投递门控 hint（EN + ZH）。

## 设计决策

1. **增量选项元数据，而不是客户端解析键名。** 渲染器保持渠道无关；
   GitHub 的角色/事件结构由拥有该词汇的插件声明。现有镜像类型测试守护
   两份类型定义。
2. **复用 JSON 字符串 draft 契约。** 不改 `channel-editor-state`；必填
   校验、保存过滤、高级面板「已配置」判定原样工作。
3. **角色限定翻译由基础文案生成。** 20 条 zh-CN 基础描述 + 每种语言 4 个
   分组标题，而不是 80 条重复字符串；词汇变更每种语言只改一处。英文经
   渲染器回退链复用描述符文案。
4. **全屏局部于渠道编辑器。** 迁到 `DialogShell` 会改变焦点/IME 行为与
   标题栏布局且无额外收益；局部切换符合已确认的范围。
5. **门控添加而非编辑。** 与 `prWatchEvents` 一致：保存前就在字段上指明
   前置条件，已存键保持可清除。

## 涉及文件

- `packages/channels/base/src/types.ts` —— 选项 `description`/`group`。
- `packages/sdk-typescript/src/daemon/types.ts` —— 镜像选项字段。
- `packages/channels/github/src/index.ts` —— 选项描述/分组、更短的字段
  描述。
- `packages/web-shell/client/components/channels/ChannelEditorDialog.tsx`
  与 `.module.css` —— record 渲染器、门控、位置、全屏。
- `packages/web-shell/client/i18n.tsx` —— 上述文案。
- 测试：`ChannelEditorDialog.test.tsx`（record 交互重写、新增用例）、
  `web-shell.channels.spec.ts`（新增 E2E 用例）。

## 约束与风险

- SDK 与 channel-base 类型镜像必须同一变更落地；镜像测试强制这一点。
- 已存 record 可能含描述符词汇之外的键；渲染器必须保持其可见、可删除。
- Radix Select 会渲染全部 80 项；分组分区保证可浏览。若未来键数继续增长，
  可搜索选择器是后续工作，不在本次范围。
- GitLab 必填 record 字段在没有任何非空模板时仍须校验失败
  （`recordHasRoute` 规则不变）。

## 验证计划

- 单元：`packages/web-shell` 内针对编辑器对话框的聚焦 vitest（按需成行、
  添加/删除、保存过滤空值、未知已存键、门控 hint、全屏切换、zh-CN 文案），
  以及 cli 描述符镜像/wire-shape 测试。
- E2E：Playwright `web-shell.channels.spec.ts` + mock daemon——通过选择器
  添加/编辑/删除模板并断言 upsert 载荷；切换全屏。用例带 `@smoke` 标记，
  确保 CI smoke 任务（`test:e2e:smoke`，`--grep @smoke`）真的会跑它。
  实现前的基线运行必须失败（功能尚不存在）。
- 仓库根执行 `npm run build && npm run typecheck`。

## 验收标准

- 新建 GitHub 渠道 draft 显示 0 个模板行和 1 个添加选择器；选择器在 4 个
  带标题分组里列出全部 80 个键并附描述。
- 已配置键渲染为多行行，带描述与删除按钮；保存过滤空值、保留未触碰的键。
- 绑定投递关闭时添加被禁用并给出指明开关的 hint；已有行仍可删除。
- 对话框可切换全屏并还原；body 占满放大后的对话框。
- zh-CN 显示翻译后的描述、分组标题与界面文案。
- GitLab record 字段在新渲染器下保持必填校验与自带说明的 label。

## 开放问题

无阻塞项。可搜索选择器与逐模板字数计数是 operator 提出需求后的可选后续。
