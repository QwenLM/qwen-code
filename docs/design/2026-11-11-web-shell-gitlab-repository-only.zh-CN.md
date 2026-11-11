# Web Shell 对 GitLab 的仅仓库支持

[English](2026-11-11-web-shell-gitlab-repository-only.md) | [简体中文](2026-11-11-web-shell-gitlab-repository-only.zh-CN.md)

状态：已实现并本地验证；待评审。泛化 Web Shell 渠道编辑器的“仅仓库”模型——它目前
围绕 GitHub 的 `owner/repo` 形状建造——使 GitLab 被接入时既不渲染惰性私聊控件、
也不拒绝嵌套项目路径、也不破坏混合大小写项目路径。

## 问题陈述

GitLab 是仅群组渠道：`GitlabAdapter.buildEnvelope`
（`packages/channels/gitlab/src/GitlabAdapter.ts`）对每个 envelope 都硬编码
`isGroup: true`，与 GitHub 完全一致。但
`packages/web-shell/client/components/channels/channel-platform.ts` 中的
`REPOSITORY_ONLY_CHANNEL_TYPES` 只含 `github`，因此 Web Shell 编辑器仍为 GitLab
渲染被注入的私聊控件（`privatePolicy`、`allowedUsers`），尽管适配器从不读取它们。
这是 #16746 为 Email 修复的缺陷的镜像（仅私聊渠道渲染惰性群组控件），并在该改动
的设计文档中记为遗留项。

把 GitLab 加入集合是必要的，但**不充分**，有两个独立原因：

1. 仅仓库允许列表机制围绕 GitHub 的单斜杠 `owner/repo` 形状建造，会拒绝合法的
   GitLab 嵌套项目路径，如 `group/subgroup/project`。
2. 编辑器的仅仓库别名模型把群组键小写化，但 GitLab 适配器按大小写敏感匹配群组键。
   GitLab 项目路径保留大小写，故朴素接入会静默破坏每个混合大小写项目。

## 现状

### 运行时接受嵌套群组键；编辑器不接受

daemon store（`packages/cli/src/serve/channel-settings-store.ts`，
`assertSharedField` 的 `groups` 分支）对群组键只禁止原型污染
（`__proto__`、`constructor`、`prototype`）；其余任意字符串键都可存储。
`GroupGate.groupConfigFor`（`packages/channels/base/src/GroupGate.ts`）先按逐字
字符串相等把入站 `chatId` 与群组键匹配，再按各适配器的 `normalizeGroupId` 匹配——
对路径段数没有任何约束。因此 `group/subgroup/project` 这样的嵌套键在运行时天然
可用。

单斜杠限制完全来自编辑器：`REPOSITORY_FULL_NAME_RE`
（`channel-editor-state.ts`），被 `validateChannelEditorDraft` 的允许列表校验与
`repositoryAllowlistIds` 使用，后者驱动每仓库覆盖行。GitLab 入集后，合法的嵌套
项目路径会被判为 `invalidRepoId`。这是实测的：允许列表含
`mygroup/subgroup/project` 的 draft，接入前校验通过，朴素接入后返回
`{"allowedGroupIds":"invalidRepoId"}`。

### GitLab chat ID 嵌套且保留大小写

`GitlabAdapter` 设 `chatId = todo.project.path_with_namespace`。GitLab 的
`path_with_namespace` 是完整命名空间路径——项目位于子群组时为
`group/subgroup/project`——且**保留大小写**。GitLab 的路径文法允许大写字母，
gitlab.com 上存在混合大小写项目（例如 `CalcProgrammer1/OpenRGB`，已对线上 API
核实）。GitLab web 路由大小写不敏感，故仅大小写不同的两种拼写指向同一项目。

适配器未声明 `normalizeGroupId` 覆写，故基类恒等归一器生效，GitLab 的运行时
允许列表匹配是大小写敏感精确匹配——与 GitLab 大小写不敏感路由的潜在不一致。

### 编辑器的小写模型会与混合大小写路径失配

仅仓库别名模型把群组键小写化（draft 播种、`repositoryAllowlistIds`、带
`normalizeKeys` 的 `assignGroups`、`configuredGroupOverrides`）。GitHub 把
`normalizeGroupId` 覆写为 lowercase
（`packages/channels/github/src/GithubAdapter.ts`），故其运行时把 `Owner/Repo`
与 `owner/repo` 视为同一仓库，编辑器的小写化与之匹配。把同一编辑器模型套到大小写
敏感的 GitLab 运行时，会把存储键小写化而入站 `chatId` 保留大小写，于是混合大小写
项目的允许列表条目永不匹配：准入 fail-closed、再保存把可用的混合大小写键改写为
小写、每项目发言人收窄静默回退到 open 默认。

### GitHub 独有字段对 GitLab 保持惰性

GitHub URL 缩短（`normalizeRepositoryFilterInput`、`GITHUB_REPOSITORY_URL_RE`、
`GITHUB_RESERVED_URL_PATHS`）只作用于 `repoFilter`。`repoFilter` 校验块与保存路径
归一化都按 `descriptor.type === 'github'` 门控——而非更宽的仅仓库集合。保存路径
的门禁即便在 GitLab 不声明 `repoFilter` 字段时也有意义：请求 config 从存量 config
播种，故 GitLab 渠道可能携带一个被保留、不受管理的 `repoFilterMode`/`repoFilter`，
daemon 仅在其逐字节未变时才容忍。保存时归一化它会让 daemon 拒绝该渠道此后的每次
保存。GitLab 也不声明 `useLocalGh`。`githubEventWebUrl` 已按 type 门控到 `github`。

### 存量条目不得阻塞无关编辑

把 GitLab 纳入仅仓库集合，会使其既有允许列表被套上从未通过的形状校验，并把其存量
群组键改写大小写。两处容忍确保无关编辑（例如轮换 token）不会被操作者从未动过的
条目卡住：

- 编辑器形状校验跳过已存在于存量 groups 的条目（大小写不敏感比对，因为 draft 把
  仓库 id 小写化），与数字字段分支对存量值既有的约定一致。
- daemon store 的“未变值容忍”跟随群组键的大小写改写：精确键缺失时回退到对上一条目
  的大小写不敏感匹配，镜像 `GroupGate.groupConfigFor` 的先精确后归一顺序，精确拼写
  始终优先。

### 仓库 UX 文案曾是 GitHub 措辞

若干仅仓库字符串点名 GitHub：允许列表字段
（`channels.editor.field.github.allowedRepos`，“repository full names, for
example owner/repo”）、允许列表校验修复指示
（`channels.editor.validation.invalidRepoId`，“Enter each repository as
owner/repo.”）、每项目发言人描述
（`channels.editor.field.github.repositorySpeakers.description`/`.inherited`,
“GitHub logins…”）。其余仓库字符串（`repositorySettings`、`requireMention`、
`repositorySenders`）用通用的“repository”措辞，对 GitLab 项目可接受。

## 目标

1. GitLab 被接入为仅仓库：编辑器隐藏惰性私聊控件，群组轴保持可编辑。
2. 允许列表接受嵌套 GitLab 项目路径（`group/subgroup/project`），仍拒绝畸形条目。
3. 混合大小写 GitLab 项目路径正确准入，并在再保存后存活。
4. GitHub 的严格 `owner/repo` 校验不变。
5. 允许列表字段、其校验修复指示、发言人描述显示 GitLab 项目措辞，而非 GitHub
   `owner/repo` / “GitHub logins”。
6. 保存 GitLab 渠道时丢弃被注入的私聊残留，与 GitHub 一致。

## 范围边界

范围内：仅仓库谓词、通道感知的仓库 ID 形状、GitLab `normalizeGroupId` 覆写、
GitLab 仓库文案，及其测试。

范围外，及原因：

- **`repoFilter`、URL 缩短、`useLocalGh`。** GitLab 不声明这些 GitHub 独有字段；
  其路径对 GitLab 永不触发。泛化它们将是投机性的。
- **事件页的 `githubEventNumber`。** `ChannelEventsPage` 对任何渠道解析 GitHub
  thread 格式；GitLab thread 是否命中是另一关切，不属于编辑器泛化。
- **编辑器内通道感知的别名归一化。** 适配器归一化大小写后（见下），共享 lowercase
  别名模型对两平台都正确；把编辑器别名模型改成通道感知会增加复杂度而无可观察收益。

## 提议的改动

### GitLab 群组匹配变为大小写不敏感

`packages/channels/gitlab/src/GitlabAdapter.ts`：`GitlabChannel` 覆写
`normalizeGroupId` 为 lowercase，镜像 `GithubChannel`。GitLab 路由大小写不敏感、
大小写变体路径是同一项目，故大小写不敏感的群组匹配是语义正确的行为。
`GroupGate.groupConfigFor` 对入站 `chatId` 与存储键都归一化，故任意大小写输入的
允许列表都能准入该项目并解析其发言人策略。这使编辑器既有的 lowercase 模型与运行时
一致，并使别名模型的大小写折叠正确（大小写变体是同一项目）。

### 通道感知的仓库 ID 形状

`channel-editor-state.ts`：门控仅仓库行为的那两处 `REPOSITORY_FULL_NAME_RE` 使用
（允许列表校验与 `repositoryAllowlistIds`）经 `repositoryIdPattern(type)` 变为
通道感知。GitHub 保持恰好两段（`owner/repo`）；GitLab 接受两段或更多
（`group[/subgroup…]/project`），每段匹配 `[A-Za-z0-9_.-]+`。`repoFilter` 校验
保持严格 GitHub 正则，因为该块仅 GitHub。`repositoryAllowlistIds` 增加通道类型
参数，从 `buildChannelUpsertRequest` 经 `removeGroupAllowlistMembership`、以及从
对话框穿线而来。允许列表形状校验容忍已存在于存量 groups 的条目（大小写不敏感），
故接入 GitLab 不会让无关编辑被先于形状校验存在的存量条目卡住。

### 谓词

`channel-platform.ts`：`REPOSITORY_ONLY_CHANNEL_TYPES` 变为
`new Set(['github', 'gitlab'])`。

### 守护保留键与大小写改写条目

`channel-editor-state.ts`：保存路径的 `repoFilter` 归一化按
`descriptor.type === 'github'` 门控（与校验块一致），故 GitLab 渠道上被保留、不受
管理的 `repoFilter` 永不被改写。
`packages/cli/src/serve/channel-settings-store.ts`：`groups` 的“未变值容忍”在精确键
缺失时回退到对上一条目的大小写不敏感匹配，故保存时改写群组键大小写不会丢掉对未变
legacy 嵌套值的容忍。精确拼写始终优先。

### GitLab 仓库文案

`ChannelEditorDialog.tsx` 按 `descriptor.type` 为允许列表字段
（`channels.editor.field.gitlab.allowedRepos`）、允许列表校验修复指示
（`channels.editor.validation.invalidProjectPath`）、大小写变体冲突修复指示
（`channels.editor.validation.conflictingProjectAliases`）、每项目发言人描述
（`channels.editor.field.gitlab.repositorySpeakers.description`/`.inherited`）
选用 GitLab 变体。`i18n.tsx` 两语各新增这些键：“Allowed projects”/“允许的项目”、
项目路径描述与 `group/project` 占位符、“Enter each project as a path, for example
group/subgroup/project.”、项目路径冲突修复指示、以及“GitLab usernames…”。通用的
发言人标签与占位符保持共享。

### 测试

- 谓词：GitLab 是仅仓库；可私聊平台不是。
- 适配器：混合大小写项目路径经 lowercase `chatId` 解析其发言人允许列表与其允许列表
  准入（恒等归一器下实测为红）。
- 对话框：GitLab 隐藏私聊控件；允许列表两语显示项目路径文案；畸形条目显示项目路径
  修复指示；大小写变体键显示项目路径冲突修复指示；发言人描述与继承文案两语写
  “GitLab usernames”。
- 编辑器状态：嵌套 GitLab 路径可校验并保存；新输入的畸形条目被拒，而先于形状校验
  存在的存量条目被容忍；存量混合大小写项目在再保存后保留其发言人策略；被保留的
  `repoFilter` 原样往返；GitHub 仍拒绝多段 id；保存时丢弃私聊残留。
- daemon store：大小写改写的群组键对 legacy 嵌套值保留“未变值容忍”，改值仍被拒。

## 关键设计决策

| 决策                                                | 理由                                                                                                                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新增 GitLab `normalizeGroupId` lowercase 覆写       | GitLab 路由大小写不敏感、`path_with_namespace` 保留大小写；大小写不敏感匹配语义正确且镜像 GitHub。它使编辑器 lowercase 模型与运行时一致，而非强迫编辑器保留大小写。 |
| 通道感知段数，而非通用放宽正则                      | 通用 2+ 段正则会让 GitHub 接受永不匹配仓库的多斜杠 id，丢失拼写错误检测。GitHub 保持严格形状。                                                                      |
| 保留共享 lowercase 别名模型                         | 适配器归一化大小写后，大小写变体对两平台都是同一项目，故共享模型正确；通道感知的编辑器归一化增加复杂度而无收益。                                                    |
| 仅点名平台的文案通道感知                            | 其余仓库字符串用通用“repository”措辞，对 GitLab 项目可接受；复制它们是投机性的。                                                                                    |
| `repoFilter`/URL 缩短/`useLocalGh` 保持 GitHub 独有 | GitLab 不声明这些字段。保存路径 `repoFilter` 归一化显式按 GitHub 门控，因为请求 config 从存量播种，被保留、不受管理的 `repoFilter` 不得被改写。                     |
| 接入时容忍存量条目                                  | 形状校验跳过存量条目、store 的“未变值容忍”跟随大小写改写的键，故接入 GitLab 不会让无关编辑被操作者从未动过的条目卡住。                                              |

## 约束

- 编辑器由每个已接入平台共享。形状改动不得改变 GitHub、DingTalk、DWS、WeCom、
  WeCom Callback、Feishu、Email 的行为。
- 适配器覆写把 GitLab 群组匹配从大小写敏感改为大小写不敏感。这是与 GitLab 路由
  对齐的 bugfix：既有 lowercase 配置仍匹配，混合大小写配置现在也匹配。
- daemon store 接受任意群组键；编辑器的形状校验是易用性守卫，而非安全边界——
  运行时允许列表是 fail-closed。
- 两张语言表必须在同一次改动中更新，且由测试渲染到。

## 风险

| 风险                          | 缓解                                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| 放宽形状泄漏到 GitHub         | 形状按通道类型 keyed；测试钉住 GitHub 拒绝多段 id。                                          |
| 混合大小写路径仍失配          | 适配器覆写归一化两侧；适配器测试钉住混合大小写键经 lowercase chatId 解析，无覆写时实测为红。 |
| GitLab 文案回退到 GitHub 措辞 | 对话框测试钉住项目路径占位符/描述、项目路径修复指示、“GitLab usernames”发言人文案。          |
| 嵌套路径在保存时被拒          | 编辑器状态测试校验并保存 `group/subgroup/project`；形状改动前实测为红。                      |
| 适配器覆写改变既有行为        | 大小写不敏感匹配只把准入放宽到同一项目的大小写变体；lowercase 配置不受影响。                 |

## 验证计划

1. 定向 vitest 套件：`packages/web-shell` channels 目录（`channel-platform`、
   `channel-editor-state`、`ChannelEditorDialog`、`channel-editor-parity`、
   `ChannelsManagerPage`）、`packages/channels/gitlab`（`GitlabAdapter`）、以及
   `packages/cli`（`channel-settings-store`）。
2. 仓库门禁：`tsc --noEmit`（web-shell 与 gitlab）、改动文件的 ESLint 与 Prettier。
   完整 web-shell `vite build` 在本检出被既有的缺失 `browserify` 依赖阻断（在
   `package.json` 声明但本地 `node_modules` 缺失）；与改动相关的 `tsconfig.lib.json`
   编译通过，CI 的干净安装可构建。
3. 变异见证：从集合移除 GitLab、回退通道感知形状、回退文案选择、或回退适配器覆写，
   各让对应钉子变红。边界守卫（GitHub 保持严格、可私聊平台保持在外）按设计在 base
   上绿，杀过宽变异，而非充当回归见证。

## 验收标准

1. GitLab 呈现为仅仓库；编辑器不为它渲染 `privatePolicy` 或 `allowedUsers`
   控件，群组轴保持可编辑。
2. GitLab 允许列表条目 `group/subgroup/project` 可校验并保存；其每仓库行渲染。
3. 混合大小写 GitLab 项目路径在运行时准入，并在再保存后存活、其每项目发言人策略
   保持完整。
4. 新输入的畸形 GitLab 条目（如单段）被拒并给出项目路径修复指示，而先于形状校验
   存在的存量条目不阻塞无关编辑。
5. GitHub 仍拒绝多段 id，如 `owner/repo/extra`。
6. GitLab 允许列表字段、校验修复指示、冲突修复指示、发言人描述/继承文案在两语下
   显示 GitLab 项目措辞，而非 `owner/repo` / “GitHub logins”。
7. 保存 GitLab 渠道不写 `privatePolicy`/`allowedUsers`，且被保留、不受管理的
   `repoFilter` 逐字节不变。
8. 大小写改写的群组键对 legacy 嵌套值保留 daemon 的“未变值容忍”；改值仍被拒。
9. 其余七个已接入平台行为不变。

## 遗留问题

- 无未决项。事件页对 GitLab 事件的 GitHub thread 编号解析仍是独立的既有关切。
