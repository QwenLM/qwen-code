# 渠道编辑器渐进式披露

[English](2026-11-04-channel-editor-progressive-disclosure.md) | [简体中文](2026-11-04-channel-editor-progressive-disclosure.zh-CN.md)

状态：提案（2026-11-04），评审第 1 轮后修订

## 问题

Web Shell 渠道编辑器（`ChannelEditorDialog.tsx`，七个平台共用）把描述符里的所有字段平铺渲染。GitHub 新建实例大约显示 16 个控件，每个字段还带一段描述：

- 低频字段（`pollInterval`、`reasonFilter`、`messageRoutes`、`defaultMessageRoute`、`multiSession`、`instructions`）与必填凭据处于同一层级。
- 仅 `reasonFilter` 一项就渲染 15 个始终展开的复选框 pill。

对话框正文远超视口高度，首次配置真正需要的字段（名称、工作区、认证、端点、群组策略）被淹没在噪音里。

## 现状

- 分区已经由 key 集合驱动：`packages/web-shell/client/components/channels/ChannelEditorDialog.tsx` 中的 `CONNECTION_FIELD_KEYS`、`SHARED_ACCESS_FIELD_KEYS`、`SHARED_SESSION_FIELD_KEYS`。
- 保存与校验遍历**全部**描述符字段，与是否渲染无关：`channel-editor-state.ts` 的 `buildChannelUpsertRequest` 和 `validateChannelEditorDraft` 对每个字段读取 `draft.values`。因此隐藏字段既不改变保存内容，也不改变校验范围。
- 同一对话框已有条件显示先例：`allowedUsers` 仅在 allowlist/pairing 下显示，`groupAllowedUsers` 仅在 senders 为 allowlist 时显示，逐仓库行仅在群组策略为 allowlist 时显示。
- 与本设计相关的一条硬运行时依赖：`defaultMessageRoute` 必须指向已配置的路由（`packages/channels/base/src/ChannelBase.ts`，构造函数抛出 `defaultMessageRoute must name a configured message route.`）。
- `prWatchEvents` / `deliverToBoundSessions` 的依赖由 PR #16236 单独处理：它保留两个字段可见，用禁用控件、内联提示和客户端校验表达依赖。本设计刻意不动这两个字段的可见性，使两个改动互补。
- 统一 `radix-ui` 包（已是 web-shell 依赖）导出 `Collapsible` 原语；现有 `ui/` 原语全部从 `radix-ui` 导入。本改动之前没有 `collapsible.tsx` 包装。

## 目标

- 把 GitHub 编辑器的默认视图收缩到首次配置所需的字段。
- 每个已配置值要么可见、要么一次点击可达，且绝不隐藏校验错误。
- 不改变保存/校验语义，不改变描述符/协议表面。

## 范围边界

- 仅 Web Shell：`ChannelEditorDialog.tsx`、其 CSS module、新增 `ui/collapsible.tsx` 原语、`channel-editor-state.ts`（一个共享 record 判定）、`i18n.tsx`、同址测试，以及 visuals 截图场景。
- 不改 `packages/cli`、`packages/core`、`packages/channels` 或 SDK 类型。
- 不在本轮范围：监视事件依赖 UX（PR #16236）、`reasonFilter` 紧凑多选、描述文案瘦身、tabs/向导式重构。这些保留为可能的后续工作。

## 方案

### 1. 条件显示默认消息路由

- `defaultMessageRoute` 仅在 `messageRoutes` 至少含一条非空路由**或**其自身非空时渲染。第二个析取项让无效的存储值保持可见、可修复，而不是藏起唯一能修复它的控件。“含路由”采用与 `assignField` 写入相同的形状：至少含一个非空字符串值的 JSON record。

### 2. 高级设置折叠区

- 新增 `ADVANCED_FIELD_KEYS` 集合，沿用现有 key 集合模式：`pollInterval`、`reasonFilter`、`messageRoutes`、`defaultMessageRoute`、`multiSession`、`instructions`。
- 刻意排除：
  - `baseUrl` 与 `wsUrl` 是主端点：它们决定 token 发往哪里（GitHub Enterprise / 自建 GitLab、WeCom）。全新草稿必须显示它们，因此留在 Connection。两者的描述符都没有声明 `required`；排除的理由是“平台主端点”，而不是 required 标志。
  - `operators` 是一处权限授予（“谁可以批准工具调用”），应与 `privatePolicy`、`allowedUsers` 一起留在访问控制，而不是藏在标着“调优项”的折叠区后面。这是刻意的产品决策，不是 key 集合带来的后果。
  - 集合里只放非 enum key：`initialFieldValue` 会用默认值预填 enum，因此一个 enum key 会让每个全新草稿都算作已配置并自动展开面板，悄悄抵消精简的默认视图。集合上的注释记录了这一陷阱。
- 现有字段分区（凭据/连接、会话、访问）各自排除高级 key。高级字段按描述符顺序在表单末尾（访问控制之后）的一个折叠面板中渲染。原 `routing` 分区在所有路由 key 移入面板后不可达，其脚手架（`ROUTING_FIELD_KEYS`、分区映射项、`fieldSectionKey` 分支）被删除而不是留作死代码。
- 面板作用于所有平台（编辑器共用）；GitHub 收益最大。DingTalk 的 `outputMode` 留在会话管理。
- 展开/收起状态：
  - 对话框打开时，若任一高级字段已配置则面板初始**展开**：布尔为 `true`、record 含非空路由、其余 kinds 含非空去空白字符串。否则初始收起。
  - 收起状态下面板显示已配置高级字段的数量徽标，确保没有东西被静默隐藏。
  - 提交时若任一高级 key 存在校验错误，先强制展开面板，**并把第一个出错的高级字段滚入视野**（对话框正文是唯一滚动容器）——只展开面板可能让错误仍在视口下方。
- Radix `Collapsible` 收起时卸载内容。草稿值保存在对话框 state 中，收起不会丢弃任何编辑，校验与序列化继续覆盖每个字段。
- 无障碍：面板标题是包裹触发按钮的真实 `<h3>`（WAI-ARIA 手风琴写法）。ARIA 会让按钮的后代变成表现性内容，因此按钮内的 span 标题对标题导航不可见；标签与徽标仍留在按钮内，可访问名称不变。

### 3. 共享 record 判定

- `channel-editor-state.ts` 的 `recordHasRoute` / `parseRouteRecord` 是 record 规则（“至少含一个非空字符串值的 JSON record”）的唯一来源。校验（`isMissingField`）、保存路径（`assignField`）与编辑器的可见性/自动展开判定都读它，三者不会脱钩。对话框只保留一个薄薄的草稿值适配层（`draftHasRoute`）。

### 4. 原语与文案

- 按仓库风格新增 `packages/web-shell/client/components/ui/collapsible.tsx`（shadcn 结构，`import { Collapsible as CollapsiblePrimitive } from 'radix-ui'`，`data-slot` 属性；三个包装均用 `React.forwardRef`，满足仓库 React 18/19 ref 契约，由 `react18-ref-compat.test.tsx` 钉住）。无新依赖、无 portal，因此不需要 portal-root 集成。
- 两个 locale map 各新增 i18n key：
  - `channels.editor.section.advanced` — "Advanced settings" / "高级设置"
  - `channels.editor.section.advanced.description` — 一句话说明面板存放少改的调优项。
  - `channels.editor.section.advanced.configuredCount` — 参数化数量徽标，如 "2 configured" / "已配置 2 项"。
- 现有字段标签与描述不动。

## 设计决策与理由

| 决策                                     | 理由                                                                                                       |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| key 集合分区，而非描述符标志             | 与现有分区机制一致；无协议变更，不涉及 CLI/core 门禁。                                                     |
| 监视事件依赖让位 PR #16236               | 该 OPEN PR 已用禁用控件与客户端校验表达依赖；在此隐藏同一批字段会构成互斥、冲突的 UX。                     |
| `baseUrl` / `wsUrl` 留在 Connection      | 它们是决定 token 发往哪里的主端点；埋掉它们会让新建企业渠道在没有端点的情况下保存，把 token 发往公共 API。 |
| `operators` 留在访问控制                 | 它授予权限；“谁可以批准工具调用”的可发现性比默认视图少一行更重要。刻意的产品决策。                         |
| `defaultMessageRoute` 自身非空时保持可见 | 存储的无效值必须能在表单里修复。                                                                           |
| 已配置值自动展开；错误强制展开并滚动     | 折叠绝不能让值或错误脱离视线；只展开面板可能让错误仍在视口下方。                                           |
| 标题包裹触发器                           | ARIA 让按钮后代变成表现性内容；只有按钮外的真实标题才能被标题导航到达。                                    |
| 一个共享 record 判定                     | 校验、保存、可见性此前只是恰好一致；一个导出规则让它们继续一致。                                           |
| 高级面板置底、单一面板                   | 干扰最小的位置；一个披露控件而非多个。                                                                     |

## 约束与风险

- 现有测试固定了分区归属；将它们更新到新归属（先展开面板），同时保持断言有意义。bound-session 标签测试不动，因为监视事件可见性在此不变。
- 其他平台默认视图失去路由分区（`messageRoutes`、`defaultMessageRoute` 移入高级）。这是预期且一致的；已配置渠道由自动展开保护。
- 数量徽标把显式输入的默认值（如 `pollInterval` `60000`）视为已配置。可接受：它不同于“未设置”，而徽标报告的正是后者。
- 默认视图比第一版略高，因为 Connection（含 `baseUrl`）保持可见；企业端点的正确性优先于少一行。

## 验证计划

- 单元测试（同址，vitest + jsdom）：
  - `defaultMessageRoute` 无路由时隐藏、有路由或自身有值时显示。
  - 全新 GitHub 草稿下高级面板收起且 `baseUrl` 仍在 Connection；已配置实例打开时展开，字符串、布尔、record 三个判定分支各有独立用例钉住；收起时断言徽标计数。
  - 面板标题是包裹触发按钮的 `<h3>`。
  - 收起的高级字段上的校验错误在提交时强制展开面板，并把出错控件滚入视野（scrollIntoView 桩见证）。
  - 保存载荷一致性：收起的高级值仍原样序列化。
  - 主端点（`baseUrl`、`wsUrl`）留在 Connection 而调优项折叠；新 key 的 zh-CN 文案；更新后的分区归属测试。
  - 变异见证：每个新机制（端点归属、标题、布尔分支、record 分支、滚动）都有一个恰好让其测试变红的变异。
- 从 `packages/web-shell` 运行 `npm run build`、`npm run typecheck`、lint 及聚焦的 web-shell 测试文件。
- Visuals e2e harness：按仓库 visuals 工作流，对 GitHub 编辑器出 before/after 截图（暗/亮各一），锚定收起面板及其标题；仓库设置场景在真实浏览器中锚定已配置实例的自动展开与数量徽标。

## 验收标准

- 全新 GitHub 编辑器显示 Identity、Credentials、Connection（含 `baseUrl`）、会话隔离、Access control（含 `operators`），以及标题为真实标题的收起 Advanced settings 面板。
- 已配置的高级值在编辑时展开面板；其内的校验错误在提交时强制展开并把出错字段滚入视野。
- 保存/校验语义不变。
- 聚焦测试、typecheck、build、lint 全部通过。

## 开放问题

无阻塞项。徽标语义（非空高级字段计数）由本设计固定。
