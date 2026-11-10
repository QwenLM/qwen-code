# Web Shell 对 GitLab 的仅仓库支持

[English](2026-11-11-web-shell-gitlab-repository-only.md) | [简体中文](2026-11-11-web-shell-gitlab-repository-only.zh-CN.md)

状态：提议中。泛化 Web Shell 渠道编辑器的“仅仓库”模型——它目前围绕 GitHub 的
`owner/repo` 形状建造——使 GitLab 被接入时既不渲染惰性的私聊控件，也不拒绝嵌套
项目路径。

## 问题陈述

GitLab 是仅群组渠道：`GitlabAdapter.buildEnvelope`
（`packages/channels/gitlab/src/GitlabAdapter.ts:434`）对每个 envelope 都硬编码
`isGroup: true`，与 GitHub 完全一致。但
`packages/web-shell/client/components/channels/channel-platform.ts` 中的
`REPOSITORY_ONLY_CHANNEL_TYPES` 只含 `github`，因此 Web Shell 编辑器仍为 GitLab
渲染被注入的私聊控件（`privatePolicy`、`allowedUsers`），尽管适配器从不读取它们。
这是 #16746 为 Email 修复的缺陷的镜像（仅私聊渠道渲染惰性群组控件），并在该改动
的设计文档中记为遗留项。

把 GitLab 加入集合是必要的，但**不充分**：仅仓库机制围绕 GitHub 的仓库形状建造，
朴素的一行接入会引入回归。

## 现状

### 运行时接受嵌套群组键；编辑器不接受

daemon store（`packages/cli/src/serve/channel-settings-store.ts`，
`assertSharedField` 的 `groups` 分支）对群组键只禁止原型污染
（`__proto__`、`constructor`、`prototype`）；其余任意字符串键都可存储。
`GroupGate.groupConfigFor`（`packages/channels/base/src/GroupGate.ts:43-50`）
先按逐字字符串相等把入站 `chatId` 与群组键匹配，再按各适配器的
`normalizeGroupId` 匹配——对路径段数没有任何约束。因此 `group/subgroup/project`
这样的嵌套键在运行时天然可用。

单斜杠限制完全来自编辑器：
`REPOSITORY_FULL_NAME_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/`
（`channel-editor-state.ts:91`），被允许列表校验
（`validateChannelEditorDraft`，`:646`）与 `repositoryAllowlistIds`（`:100`）
使用，后者驱动每仓库覆盖行。GitLab 入集后，合法的嵌套项目路径会被判为
`invalidRepoId`。这是实测的：允许列表含 `mygroup/subgroup/project` 的 draft，
接入前校验为 `{}`，朴素接入后为 `{"allowedGroupIds":"invalidRepoId"}`。

### GitLab chat ID 嵌套且小写

`GitlabAdapter.ts:254` 设 `chatId = todo.project.path_with_namespace`。GitLab 的
`path_with_namespace` 是完整命名空间路径——项目位于子群组时为
`group/subgroup/project`——且 GitLab 强制路径段小写。适配器从不 lowercase
`chatId`，也未声明 `normalizeGroupId` 覆写，因此 GitLab 的运行时允许列表匹配是
大小写敏感的精确匹配。

### GitHub 归一化大小写；编辑器的别名模型已同时适配两者

GitHub 把 `normalizeGroupId` 覆写为 lowercase
（`packages/channels/github/src/GithubAdapter.ts:1806-1808`），故其运行时把
`Owner/Repo` 与 `owner/repo` 视为同一仓库。编辑器的仅仓库别名模型（lowercase 键、
`conflictingRepositoryAliases`、带 `normalizeKeys` 的 `assignGroups`）与之镜像。
对 GitLab，真实路径本就小写，因此同一 lowercase 模型是一致的——它还把操作者的
混合大小写输入规范化为运行时匹配的小写路径。无需通道感知的归一化。

### GitHub 独有字段对 GitLab 保持惰性

GitHub URL 缩短（`normalizeRepositoryFilterInput`、`GITHUB_REPOSITORY_URL_RE`、
`GITHUB_RESERVED_URL_PATHS`）只作用于 `repoFilter`
（`channel-editor-state.ts:1037-1052`），按
`isRepoFilterActive(config['repoFilterMode'])` 门控。`repoFilter` 校验块按
`descriptor.type === 'github'` 门控（`:591`）。GitLab 既不声明
`repoFilter`/`repoFilterMode` 也不声明 `useLocalGh`，故这些 GitHub 专属路径对它
永不触发。`githubEventWebUrl` 已按 type 门控到 `github`。

### 仓库 UX 文案是 GitHub 措辞

允许列表字段对任何仅仓库渠道渲染
`channels.editor.field.github.allowedRepos`（标签/描述/占位符）
（`ChannelEditorDialog.tsx:1838-1862`）。其描述写“repository full names, for
example owner/repo”，占位符是 `owner/repo`——对 GitLab 的嵌套项目路径是错的。
其余仓库字符串（`repositorySettings`、`requireMention`、senders/speakers）用通用
的“repository”措辞，对 GitLab 项目可接受。

## 目标

1. GitLab 被接入为仅仓库：编辑器隐藏惰性私聊控件，群组轴保持可编辑。
2. 允许列表接受嵌套 GitLab 项目路径（`group/subgroup/project`），仍拒绝畸形条目。
3. GitHub 的严格 `owner/repo` 校验不变。
4. 允许列表字段对 GitLab 显示项目路径措辞，而非 `owner/repo`。
5. 保存 GitLab 渠道时丢弃被注入的私聊残留，与 GitHub 一致。

## 范围边界

范围内：仅仓库谓词、通道感知的仓库 ID 形状、允许列表文案，及其测试。

范围外，及原因：

- **`repoFilter`、URL 缩短、`useLocalGh`。** GitLab 不声明这些 GitHub 独有字段；
  其路径对 GitLab 永不触发。泛化它们将是投机性的。
- **GitLab 的 `normalizeGroupId` 运行时覆写。** GitLab 路径小写、编辑器已
  lowercase 输入，故无需改适配器运行时行为即可接入。本改动留在 Web Shell 编辑器。
- **事件页的 `githubEventNumber`。** `ChannelEventsPage.tsx:334` 对任何渠道解析
  GitHub thread 格式；GitLab thread 是否命中是另一关切，不属于编辑器泛化。
- **通道感知的别名归一化。** 共享 lowercase 模型对两平台都正确（GitLab 路径
  小写）；改成通道感知会增加复杂度而无可观察收益。

## 提议的改动

### 通道感知的仓库 ID 形状

`packages/web-shell/client/components/channels/channel-editor-state.ts`：把门控
仅仓库行为的那处 `REPOSITORY_FULL_NAME_RE` 使用替换为通道感知形状。GitHub 保持
恰好两段（`owner/repo`）；GitLab 接受两段或更多（`group[/subgroup…]/project`），
每段匹配 `[A-Za-z0-9_.-]+`。`repoFilter` 校验（`:619`）保持严格 GitHub 正则，
因为该块仅 GitHub。

`repositoryAllowlistIds` 增加通道类型参数，使每仓库行用同一形状；类型从
`buildChannelUpsertRequest` 经 `removeGroupAllowlistMembership`、以及从对话框
穿线而来。

### 谓词

`channel-platform.ts`：`REPOSITORY_ONLY_CHANNEL_TYPES` 变为
`new Set(['github', 'gitlab'])`，注释点名两个适配器的 `isGroup: true` envelope。

### 允许列表文案

`ChannelEditorDialog.tsx`：允许列表字段在 `descriptor.type === 'gitlab'` 时选用
`channels.editor.field.gitlab.allowedRepos`（标签/描述/占位符），否则用既有
`github` 键。

`i18n.tsx`：两语各新增 `channels.editor.field.gitlab.allowedRepos`、
`.description`、`.placeholder`——“Allowed projects”/“允许的项目”，
“Comma-separated project paths, for example group/subgroup/project.”/
“逗号分隔的项目路径，例如 group/subgroup/project。”，`group/project`。

### 测试

- 谓词：GitLab 是仅仓库；可私聊平台不是。
- 对话框：GitLab 隐藏私聊控件；允许列表显示项目路径文案。
- 编辑器状态：嵌套 GitLab 路径可校验并保存；畸形条目被拒；GitHub 仍拒绝多段 id；
  保存时丢弃私聊残留。
- 每个新钉子在无泛化时实测为红。

## 关键设计决策

| 决策                                                | 理由                                                                                           |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 通道感知段数，而非通用放宽正则                      | 通用 2+ 段正则会让 GitHub 接受永不匹配仓库的多斜杠 id，丢失拼写错误检测。GitHub 保持严格形状。 |
| 保留共享 lowercase 别名模型                         | GitLab 路径小写，模型一致且规范化操作者输入；通道感知归一化增加复杂度而无收益。                |
| 仅允许列表文案通道感知                              | 其余仓库字符串用通用“repository”措辞，对 GitLab 项目可接受；复制它们是投机性的。               |
| `repoFilter`/URL 缩短/`useLocalGh` 保持 GitHub 独有 | GitLab 不声明这些字段；其路径对它永不触发。                                                    |

## 约束

- 编辑器由每个已接入平台共享。形状改动不得改变 GitHub、DingTalk、DWS、WeCom、
  WeCom Callback、Feishu、Email 的行为。
- daemon store 接受任意群组键；编辑器的形状校验是易用性守卫，而非安全边界——
  运行时允许列表是 fail-closed。
- 两张语言表必须在同一次改动中更新，且由测试渲染到。

## 风险

| 风险                           | 缓解                                                                |
| ------------------------------ | ------------------------------------------------------------------- |
| 放宽形状泄漏到 GitHub          | 形状按通道类型 keyed；测试钉住 GitHub 拒绝多段 id。                 |
| GitLab 文案回退到 `owner/repo` | 对话框测试钉住 GitLab 的项目路径占位符/描述。                       |
| 嵌套路径在保存时被拒           | 编辑器状态测试校验并保存 `group/subgroup/project`；改动前实测为红。 |
| 别名模型误处理 GitLab 大小写   | GitLab 路径小写；记为已知细节，无可观察缺陷。                       |

## 验证计划

1. `packages/web-shell` 中的定向 vitest 套件：
   `channel-platform.test.ts`、`channel-editor-state.test.ts`、
   `ChannelEditorDialog.test.tsx`、`channel-editor-parity.test.ts`、
   `ChannelsManagerPage.test.tsx`。
2. 仓库门禁：`npm run build`、`npm run typecheck`、改动文件的 ESLint 与 Prettier。
3. 变异见证：从集合移除 GitLab、或回退通道感知形状，会让新钉子变红。

## 验收标准

1. GitLab 呈现为仅仓库；编辑器不为它渲染 `privatePolicy` 或 `allowedUsers`
   控件，群组轴保持可编辑。
2. GitLab 允许列表条目 `group/subgroup/project` 可校验并保存；其每仓库行渲染。
3. 畸形 GitLab 条目（如单段）被拒。
4. GitHub 仍拒绝多段 id，如 `owner/repo/extra`。
5. GitLab 允许列表字段在两语下显示项目路径文案，而非 `owner/repo`。
6. 保存 GitLab 渠道不写 `privatePolicy`/`allowedUsers`。
7. 其余七个已接入平台行为不变。

## 遗留问题

- GitLab 是否最终应获得 `normalizeGroupId` 覆写以与 GitHub 大小写不敏感匹配对齐，
  是本编辑器改动之外的运行时决策；真实 GitLab 路径小写，故此处不需要。
