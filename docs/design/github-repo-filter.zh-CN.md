# GitHub 频道按仓库过滤事件（白名单 / 黑名单）

[English](github-repo-filter.md) | [简体中文](github-repo-filter.zh-CN.md)

状态：已随本次变更实现。

## 问题

GitHub 频道会处理认证账号可见的所有仓库的通知。目前唯一的仓库级控制是
`groupPolicy: "allowlist"` 加 `groups` 键：想要「除了这些吵闹的仓库以外都处理」
的管理员无法表达这个意图；想要一个简单事件过滤器的管理员必须先理解访问策略
机制（群门禁、发言者策略、按仓库覆盖）才能配出来。

在 Web Shell 编辑器里，仓库白名单藏在「Group Policy → Allowlist →
Allowed repositories」下面。没有黑名单，而且访问策略的框架让「按仓库过滤
事件」这件简单的事变得不直观。

## 现状

- 入站事件经由 `packages/channels/github/src/GithubAdapter.ts` 的通知轮询循环
  （`pollOnce`）到达。每条通知的 subject URL 解析出 `chatId = owner/repo`；
  `reasonFilter` 已经在那里跳过通知、按轮记录有上限的 `reason_filter` 跳过
  行外加一条折叠计数行，并让游标继续前进。
- 仓库访问在其后由 `GroupGate`（`groupPolicy` + `groups`）按信封把关。编辑器
  只为这条访问路径渲染仓库行。
- 第二个事件源是 PR 状态观察（`runPrStateWatch`），服务于用户在会话里显式
  绑定到活跃会话的 PR。它不经过通知循环。
- daemon 存储（`channel-settings-store.ts`）按插件描述符校验每个配置键，并
  调用插件的同步 `validateConfig` 做跨字段规则。编辑器在
  `channel-editor-state.ts` 里镜像这些规则；`channel-editor-parity.test.ts`
  用插件自己的描述符把两侧绑在一起。

## 目标

- 用两种显式模式按仓库过滤入站 GitHub 事件：白名单（只处理列出的仓库）与
  黑名单（处理列出仓库以外的全部）。
- 在 Web Shell 编辑器里把过滤器做成一对一等公民、自解释的字段，带仓库格式
  校验，并容忍粘贴 URL。
- 通过一个共享校验函数和一张一致性表，让运行时、保存时校验器与编辑器镜像
  保持同步。

## 范围边界

- 过滤器作用于每一条入站通知，包括绑定到活跃会话的 PR 的通知。只有 PR
  状态观察事件（`runPrStateWatch`）——用户在会话里显式创建的按 PR 订阅——
  绕过它。字段描述会写明这一点。
- `groupPolicy` / `groups` 的访问控制含义不变。仓库过滤器是额外的入站过滤；
  两者同时生效时，有效集合是它们的交集。
- 不改其他频道、不改 `GroupGate`、不改共享的 `GroupPolicy` 类型。

## 方案

### 配置（GitHub 插件）

两个新的扁平描述符字段，放在 `reasonFilter` 之后：

- `repoFilterMode`：枚举 `off | allowlist | blocklist`，默认 `off`。
- `repoFilter`：`owner/repo` 条目的字符串列表。

```json
{
  "type": "github",
  "useLocalGh": true,
  "groupPolicy": "open",
  "repoFilterMode": "blocklist",
  "repoFilter": ["octo/noisy-repo", "octo/archive"]
}
```

用扁平字段（而不是一个 object 字段），因为 Web Shell 编辑器无法编辑
`object` 类字段。

### 运行时（`GithubAdapter.ts`）

- `validateRepoFilterConfig(config)` —— 导出的纯函数，返回字符串错误或
  `undefined`。规则：
  - `repoFilterMode` 缺省或 `off`：完全忽略列表（过滤器关闭时，陈旧列表
    永远不会挡住保存或连接）。
  - `repoFilterMode` 为 `allowlist`/`blocklist`：`repoFilter` 必须是非空
    字符串数组，每项 trim + 小写后匹配
    `^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`。生效的白名单若列表为空会静默丢掉
    所有事件，因此直接拒绝。
  - 其他 mode 取值一律拒绝。
- `normalizeRepoFilter(config, name)` 调用同一个校验器，出错即抛；
  `connect()` 在 `reasonFilter` 旁边存入 `{ mode, repos: Set<string> } | null`。
- 在轮询循环里，紧跟 `extractFromSubjectUrl` 之后、`reasonFilter` 之前：
  白名单跳过不在集合里的仓库，黑名单跳过在集合里的仓库（大小写不敏感）。
  被跳过的通知写 stderr、发 `repoFilter.skip` 调试载荷，并按
  `inbound / skipped / repo_filter` 记入日志，沿用与 `reason_filter` 相同的
  每轮上限（20 行）与折叠计数行。游标越过被过滤的通知继续前进，与
  reason 过滤完全一致。
- `index.ts` 的 `validateConfig` 调用 `validateRepoFilterConfig`，因此
  daemon 在保存时就以运行时相同的消息拒绝非法组合。

### 编辑器（`web-shell`）

- `channel-editor-state.ts`：
  - `normalizeRepositoryFilterInput(value, baseUrl)` —— 按逗号拆分、trim、
    剥掉粘贴可能带上的句尾标点、小写，把 GitHub web URL
    （`https://github.com/owner/repo`，可带 `.git`、尾斜杠、query、fragment
    或 `/pull/123` 式后缀）缩短为 `owner/repo`，去重后用 `, ` 连接。是否
    缩短由两道门决定。结构上，只有频道自己的 GitHub WEB 主机上的 URL 才
    可缩短：`github.com` 加上由 `baseUrl` 派生的 GitHub Enterprise web
    主机——带 `api.` 前缀的 baseUrl 主机只贡献去前缀后的形式，绝不加入
    原始 API 主机；baseUrl 自身 API 前缀（如 `/api/v3/`）下的路径也被
    排除，因此粘贴 REST URL 不会被缩短成 `repos/octo` 或 `api/v3`。其他
    任何主机——`gist.github.com`、`gitlab.com`、任意站点——原样透传交给
    校验拒绝，从结构上关闭「任意主机的头两段路径」这一类隐患。在合格
    主机上，首段路径是 GitHub 保留区域（`orgs`、`apps`、`settings`、
    `trending` 等）的 URL 仍原样透传，让校验拒绝它，而不是静默地去过滤
    一个不存在的仓库。这份区域清单在构造上就是尽力而为——对 GitHub 顶层
    路径做黑名单不可能穷尽，未来新增的区域在被补进清单之前会重新引入该
    隐患。快照断言钉住整个导出集合（移除任何成员都会红），枚举测试保证
    每个已列根路径都被拒绝，显式回归钉覆盖报告所列形态（含大写根路径）。
    其他非 URL 条目也原样通过，让校验能点名它们。
  - 校验（仅 github）：`repoFilterMode` 生效时，空列表为
    `repoFilterRequired`；归一化后仍不匹配仓库正则的条目为
    `invalidRepoId`。mode 为 `off` 时不校验列表，与运行时的「关闭即忽略」
    规则及下面的条件可见性一致。
  - `buildChannelUpsertRequest` 在发送前用同一个函数归一化 github 的
    `repoFilter` 值。
  - `initialFieldValue` 为配置里缺键的既有实例把 `repoFilterMode` 种子值
    设为 `off`（通用的既有实例路径否则会让下拉框为空）。
- `ChannelEditorDialog.tsx`：列表字段只在 mode 生效时渲染（渐进披露）。
  可见性与校验挂在同一个谓词上，隐藏字段永远不会卡住保存。mode 为 `off`
  时草稿保留列表文本，重新启用即恢复。
- i18n（en + zh）：字段标签（「Repository Filter」/「Filtered
  repositories」）、mode 选项标签（Off / Allowlist — only listed
  repositories / Blocklist — all except listed）、描述（含粘贴 URL 说明与
  PR 绑定观察的边界）、占位符 `owner/repo, owner/repo`，以及两条校验消息。

### 一致性

`channel-editor-parity.test.ts` 增加一张 repo-filter 表：同一组配置喂编辑器
镜像与 `plugin.management.validateConfig`，使用插件自己的描述符（生效
mode + 空列表、畸形条目、合法白名单/黑名单、off + 陈旧列表）。

## 设计决策与理由

- **独立的入站过滤器，而不是新的 `groupPolicy` 取值。** `GroupPolicy` 由
  所有频道共享、由 `GroupGate` 执行；在那里加 `blocklist` 会改变所有平台
  的访问控制语义。适配器级过滤器只属于 GitHub，放在 `reasonFilter` 已经
  在的位置，并与任何 group policy 复合。
- **显式 `off` mode，而不是「空列表即关闭」。** 空白名单不能静默地表示
  「屏蔽一切」或「过滤关闭」；mode 让意图显式，并让运行时拒绝这个歧义
  组合。
- **关闭时忽略列表。** 管理员可以停放一份列表、关掉过滤器、保存不相关的
  编辑，而不被停放的列表挡住保存——与存储对未变更数值已有的容忍一致。
- **编辑器归一化 URL，运行时保持严格。** 粘贴仓库或 PR URL 是自然手势；
  编辑器在保存时缩短它。`settings.json` 手编保持唯一规范拼写，否则得到
  清晰报错。
- **通知被过滤，观察事件不被过滤。** 每条通知都被过滤，包括绑定 PR 的
  通知——它们走同一个入站口。PR 绑定观察是带自己持久状态机的显式用户
  订阅；要不要过滤它是另一个决策，不在本次变更内。

## 涉及文件

- `packages/channels/github/src/GithubAdapter.ts`、`index.ts`、
  `GithubAdapter.test.ts`
- `packages/web-shell/client/components/channels/channel-editor-state.ts`、
  `ChannelEditorDialog.tsx`、它们的测试、`channel-editor-parity.test.ts`
- `packages/web-shell/client/i18n.tsx`
- `packages/web-shell/client/e2e/visuals/screenshots.spec.ts`（仓库过滤器
  编辑器截图）
- `docs/users/features/channels/github.md`
- `docs/design/github-repo-filter.md`、`docs/design/github-repo-filter.zh-CN.md`

## 验证计划

- 单元：适配器 normalize/validate 规则；轮询循环两种模式的跳过行为（大小写
  不敏感匹配、日志上限与折叠行、游标前进）；编辑器归一化/校验/保存载荷；
  一致性表。
- E2E（`.qwen/e2e-tests/github-repo-filter.md`）：对着本地 GitHub 兼容桩，
  通过 daemon API 保存两种模式，观察跳过与处理的通知以及 `repo_filter`
  日志行；编辑器渲染检查。

## 验收标准

- `repoFilterMode: allowlist` 只处理列出的仓库；`blocklist` 处理列出仓库
  以外的全部；`off`/缺省处理一切。
- 生效 mode 配空列表或畸形列表，在保存时（daemon 与编辑器）与连接时
  （运行时）都被拒绝，消息一致。
- 被过滤的通知记为 `repo_filter` 跳过，且不卡游标。
- 编辑器只在 mode 生效时显示仓库列表，接受粘贴的 GitHub URL，未触碰的
  存储值原样往返。
- 没有新键的既有频道行为与之前完全一致。

## 待定问题

无。
