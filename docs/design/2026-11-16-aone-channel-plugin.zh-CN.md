# Aone channel 插件（轮询、命令前缀触发）

[English](2026-11-16-aone-channel-plugin.md) | [简体中文](2026-11-16-aone-channel-plugin.zh-CN.md)

> 状态：已实现（本地单元 + E2E 验证完成；尚未合入）。与
> `2026-08-15-review-aone-provider.md` 和
> `2026-08-27-session-pr-aone-provider.md` 同源（复用其实测平台事实；
> 不改动它们的任何代码路径）。

## 问题

Channel 把平台的入站消息变成 agent prompt，并把 agent 回复发回平台。
代码平台 channel 已有 GitHub（Notifications API 轮询）和 GitLab（Todos API
轮询）。Aone Code——阿里内部代码平台（`code.alibaba-inc.com`，git 主机
`gitlab.alibaba-inc.com`）——没有 channel，agent 听不到 CR 评论也无法回复。

现有两个代码平台 channel 都由「面向 bot 账号的跨仓库通知收件箱」驱动。
Aone 没有已验证的等价物：`a1` CLI 不暴露 Notifications/Todos 收件箱 API。

## 已验证的平台事实（2026-11-16 实测，a1 0.2.51）

完整探针日志：`.qwen/investigations/aone-channel-inbound-probe.md`
（git 忽略）。关键事实均来自对 `middleware/tddl5` 的只读探针：

| 能力               | 命令 / 形状                                                                                | 备注                                                                                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 入站事件流         | `a1 events repo <group/project> --type comments --format json [--per-page 100] [--page N]` | 每条事件含：`id`（单调事件 id）、`createdAt`、`author`（username）、`user.name`、`note.id`、`note.note`（评论全文）、`note.noteable_type`、`mergeRequest.{id,iid}`（`id` 是全局 CR id）、`projectDetail.path_with_namespace`。按时间降序。 |
| 窗口 / 分页        | 文档缺省窗口 = 今天 − 3 天 → 今天；最大跨度 30 天；`--per-page` ≤ 100，`--page` ≤ 100      | FAQ「events 活动事件」页描述了自动补全，但 a1 0.2.51 实测**拒绝**省略日期（"--since and --until are required and must be used together"）。适配器显式传 3 天窗口，用本地日历日期。                                                         |
| `events user` 语义 | 该用户**发起**的活动，不是收件箱                                                           | 判别探针：查某用户返回其本人刚发的评论。a1 无跨仓库「@我」API。                                                                                                                                                                            |
| 行内评论           | 出现在事件流中                                                                             | AGit-Flow 旧 patchset 的行内评论在 `comment list` 所有模式都消失，但事件流保留——事件流是更完整的来源。                                                                                                                                     |
| 出站               | `a1 repo mr comment create --repo <g/p> --mr <全局id> -m <body> [--reply-to <note-id>]`    | 写一次性语义（review provider 先例）：写操作绝不重试。                                                                                                                                                                                     |
| 身份               | `a1 auth whoami --format json` → `account`                                                 | bot 身份即 channel 主机上 a1 登录的账号。                                                                                                                                                                                                  |
| 错误               | 退出码不可靠                                                                               | a1 可能在 exit 0 或 exit 1（stdout）返回 `{"schemaVersion":"a1.error/v1",...}`。解析出的形状才是错误信号。                                                                                                                                 |
| 触发约定           | 命令前缀，而非 @mention                                                                    | tddl5 近 6 天 103 条评论零 @mention；团队现有 agent 工作流用前缀（`force-review:`、`precheck_all`、`test_coverage`）。平台 bot 先例：`codereview-copilot`。                                                                                |
| URL 纪律           | `mr view` 的 `detailUrl` 是唯一权威 CR 链接                                                | list 输出的 `detailUrl`/`webUrl` 为空串；Aone 链接绝不拼接（嵌套 group 折叠非单射）。                                                                                                                                                      |

## 目标

- Aone channel 适配器，打包为**扩展插件**（`plugin-example` 模式）：
  `packages/channels/aone` 下的 workspace 包，带 `qwen-extension.json`
  manifest，经 `loadChannelsFromExtensions()` 加载。**不注册内置、不改核心。**
- 入站：轮询每个配置仓库的评论事件流，派发以配置触发前缀开头的评论。
- 出站：经 `a1` 把 agent 回复发为 MR 评论。
- 复用 `PollingChannelBase`（游标持久化、轮询循环、退避）与共享的
  门禁/路由/bridge 管线。

## 非目标（v1）

- @mention 触发（语法未验证；前缀触发已覆盖团队现有约定）。mention 支持是后续项。
- Issue 评论（跳过 `noteable_type !== 'MergeRequest'`）。
- Webhook 入站（a1/FAQ 无 CR 事件 webhook 接收文档）。
- 主动发送、确认 reaction、平台消息分段。
- 超过 3 天缺省窗口的停机积压摘要（digest）。
- 内置注册表条目 / Web Shell 内置目录。

## 设计

### 包布局

```
packages/channels/aone/
  package.json            # @qwen-code/channel-aone，依赖：channel-base、zod
  qwen-extension.json     # channels.aone → dist/index.js
  tsconfig.json           # 继承 root，references ../base
  vitest.config.ts        # 兄弟包模式（gitlab）
  src/
    index.ts              # plugin 对象 + 管理面 descriptor
    AoneAdapter.ts        # PollingChannelBase 适配器
    a1-client.ts          # 异步 a1 exec + 错误对象契约 + 测试接缝
    trigger.ts            # 前缀匹配 / 剥离
    *.test.ts             # 同目录测试
```

同时加入 `package.json` 与 `pnpm-workspace.yaml` 两处的 workspaces 列表
（镜像关系由 `scripts/tests/package-scripts.test.js` 钉住）。不加入
`ensureBuiltins()`。

### 配置

```json
{
  "channels": {
    "aone-tddl": {
      "type": "aone",
      "cwd": "/path/to/an/aone/workspace",
      "repos": ["middleware/tddl5"],
      "triggerPrefixes": ["qwen:"],
      "groupPolicy": "allowlist",
      "groups": {
        "middleware/tddl5": {
          "senders": "allowlist",
          "allowedUsers": ["shaojin.wensj"]
        }
      },
      "sessionScope": "chat_thread",
      "pollInterval": 60000
    }
  }
}
```

示例刻意收紧：在全公司的代码主机上，否则任何评论者都能以 a1 登录账号的
身份在 channel 的 `cwd` 里驱动 agent 并公开回复。`groupPolicy: "open"` 加
`groups: { "*": { "senders": "open" } }` 是面向可信主机的显式 opt-in
（本地 E2E harness 用的就是它），不是推荐缺省。

- `repos`（string-list，必填，≥1）：监听的仓库全路径。没有收件箱，
  所以监听列表显式配置。匹配与存储均小写化（GitLab `normalizeGroupId`
  先例）；路由优先用事件里的规范 `path_with_namespace`。
- `triggerPrefixes`（string-list，必填，≥1）：评论正文 trim 后以任一前缀
  开头即触发，大小写不敏感。匹配到的前缀从 prompt 文本中剥离（GitHub
  mention 剥离先例）。
- `promptTemplate`（string，可选）：渲染进 `envelope.metadata` 的元数据
  模板（与 `text` 分离，slash 命令解析只看到评论正文）。变量：`%repo%`、
  `%mr_id%`、`%mr_iid%`、`%author%`、`%comment_id%`、`%title%`、`%url%`；
  `%%` 转义字面 `%`。`%title%`/`%url%` 惰性拉取 `a1 repo mr view`（每 MR
  每轮一次，缓存——GitLab `descriptionCache` 模式；**失败**的 view 同样
  负缓存一轮，被禁止的 MR 上 N 个事件只花一次调用，而不是 N × 20s 超时）；
  `detailUrl` 原样取自 view，绝不拼接。空串或纯空白回落到缺省模板
  （descriptor 写明「留空即缺省」），不得静默剥掉 CR 上下文头。缺省模板：
  `Aone CR %repo% !%mr_id% (iid %mr_iid%) | author: %author% | comment: %comment_id%`。
- 访问边界：Aone 入站全部是 group 形态（`isGroup: true`），所以
  `ChannelBase.senderGateFor` 走 **GROUP** 发送者门禁——
  `groups[<repo>].senders`（回退 `groups["*"].senders`，缺省 `open`），
  该策略为 `allowlist` 时用 `groups[<repo>].allowedUsers`。**顶层**
  `allowedUsers`/`privatePolicy` 只作用于 DM 形态流量，本 channel 从不
  产生；只配它们限制不了任何东西。`groupPolicy` 须为
  `open`/`allowlist`/`pairing` 才会派发（否则 connect 告警）；插件自行
  声明该字段、缺省 `open`，因为共享注入字段缺省 `disabled`，会让编辑器
  创建的 channel 什么都不派发。`sessionScope` 缺省 `chat_thread`
  （每仓库+MR 线程一个会话）。无 `token` 字段——a1 用 channel 主机上
  自己的登录态认证。

### 入站管线（`pollOnce`）

每个配置仓库在各自的 try/catch 里轮询：某仓库失败则记录错误并**继续**
本轮其余仓库，最后重抛第一个失败，让 base 循环记录失败轮并退避。没有
这层隔离时，未捕获的抛错会 unwind 整轮，base 循环从 `repos[0]` 重来，
一个永久坏掉的仓库会饿死排在它后面的所有仓库（它们的评论在窗口里
老化却从未被看见）。

每仓库：

1. 拉取 `events repo <repo> --type comments --since <今天−3天> --until
<今天> --per-page 100 --format json`（显式本地日历日期——a1 0.2.51
   拒绝省略），翻页（页号递增 = 事件更早）直到出现 `id ≤ cursor[repo]`
   的事件或不满页/空页。收集时按 id **去重**：最新优先列表上的偏移分页
   会在两次翻页之间有新评论插入、整体偏移移动时重复边界事件，一条评论
   绝不能在单轮里派发两次。
   若第 10 页仍满且游标未达（积压 > 1000），**继续**走到窗口尾部
   （a1 的 `--page` 上限 100），保证不跨越游标侧的缺口，然后只派发
   **最旧的 100 条**（单轮 agent 轮次有界）；余量在后续轮次排空。
   第 100 页仍满——超出平台可寻址窗口——才抛错且游标不动（防御性）。
   早先「第 10 页即抛错」的设计会让仓库在积压持续期间永久楔死，而滑动
   窗口随后恰恰静默丢掉那个抛错声称要保护的缺口。
2. 仓库首次观测（无游标条目）：基线化为最大事件 id，不派发（GitLab
   首轮排空先例）。之后新增到配置的仓库同样基线化——不派发历史积压。
   `connect()` 会剪掉不再监听的仓库的游标键，因此「移除后再加回」的
   仓库会重新基线化，而不是按陈旧 id 回放整个窗口。
3. 新事件（`id > cursor[repo]`）按 id **升序**处理：
   - 跳过 bot 自己的评论（`author.username` 等于 whoami 账号，小写化）——防循环；
   - 跳过非 MR 笔记与缺 `mergeRequest.id` 的事件；
   - 跳过不匹配任何触发前缀的正文；
   - 构造 envelope：`senderId` = 作者 username（小写），`senderName` =
     `user.name` 回退 username，`chatId` = 仓库路径，`threadId` =
     `mr:<全局 id>`，`messageId` = `note.id`，`text` = 正文减去匹配前缀，
     `isGroup: true`、`isMentioned: true`（强制——GitLab 模式；GroupGate
     仍生效）、`isReplyToBot: false`、`metadata` = 渲染后的模板；
   - `handleInbound(envelope)`；失败则记日志并发一条尽力而为的错误评论
     （GitLab 模式），然后继续；
   - 每派发/跳过一条事件后，把 `cursor[repo]` 推进到该事件 id 并
     `saveCursor()`。Aone 没有服务端「标记已读」（不同于 GitLab todo），
     持久化游标是唯一的去重状态。逐事件保存把崩溃窗口压到最小；派发与保存
     之间崩溃仍会重派那一条事件（at-least-once，与 GitLab todo-done 顺序
     相同的取舍）。

游标形状（zod 校验，GitLab 模式）：
`{ baselineAt: string, repos: Record<string, number> }`。`baselineAt` 是
channel 创建时刻（ISO，必须可解析——不可解析的值会游标校验失败并重新基线化）。
它是派发地板：创建时刻之前的事件绝不派发。没有这个地板，首轮看到**空**窗口的
仓库会基线化到 id 0，下一轮就会把整个 3 天窗口当作「新」事件派发——形成历史
积压。每仓库条目的存在性即「已初始化」状态，没有单独的标志位。
`createdAt` 解析失败的事件按 fail-closed 跳过（NaN 比较为 false），但
**必须记日志**——否则载荷形状漂移会在游标持续推进的同时静默哑掉整个
channel。

停机超过 3 天缺省窗口会丢失窗口之前的事件——已记录的限制，v1 无 digest。

### 出站（`sendThreadMessage`）

`threadId` 必须匹配 `mr:<数字>`；无线程的 `sendMessage` 抛错（GitLab
模式）。回复经
`a1 repo mr comment create --repo <chatId> --mr <id> -m <text> --format json`
发出，写一次性（不重试——重试可能重复发帖）。文本经
`formatMarkdownAttributedText`（source-label 契约）。v1 发顶层评论；
`--reply-to` 线程回复是后续项（其在行内根评论上的行为未验证）。

### a1 客户端（`a1-client.ts`）

异步 `execFile`（promisify），20s 超时，16 MiB maxBuffer，不覆盖 env
（a1 自管认证配置），每次调用带 `--no-update-check`（数天长跑的轮询器
不得中途撞上升级横幅）——即 `serve/server/aone-mrs.ts` 的传输形状，因
channel 包不能从 `packages/cli` 导入而在本地重新实现。错误契约：
ENOENT → 可操作的「安装 a1 / a1 auth login」错误；exit-1 的 stdout 与
exit-0 的正文都解析 `a1.error/v1` 对象；非 JSON 输出 → 错误。测试接缝
`setA1ExecForTest(exec?)` 与 aone-mrs 一致。无版本下限：events 命令的
引入版本未探针；缺子命令会以可操作的 a1 错误浮现，connect 时的 whoami
验证认证态。

### Plugin 对象

`channelType: 'aone'`、`displayName: 'Aone'`、
`requiredConfigFields: ['repos', 'triggerPrefixes']`、
`defaultSessionScope: 'chat_thread'`，管理面字段 `repos`、
`triggerPrefixes`、`groupPolicy`、`promptTemplate`、`pollInterval`
（kind 依次 `string-list`/`string-list`/`enum`/`string`/`number`，number
以 `exclusiveMinimum: 0` 与 `MAX_POLL_INTERVAL_MS` 为界）。`groupPolicy`
自行声明、缺省 `open`、四选项齐全——共享注入字段缺省 `disabled`，会让
编辑器创建的 channel 什么都不派发（GitLab 同样自行声明）。connect 校验：
repos 非空、前缀非空、groupPolicy 告警、whoami 成功。存在规则处，校验消息在
descriptor 与 connect 间共享（GitHub `validateRepoFilterConfig` 模式）。

## 受影响文件

- 新增：`packages/channels/aone/**`（包、manifest、适配器、客户端、
  触发器、测试），本设计文档对。
- 编辑：根 `package.json` + `pnpm-workspace.yaml`（workspaces 列表）、
  `.pnpmfile.mjs`（workspace rewrite 集合）、
  `scripts/tests/unit-vitest-configs.test.ts`（vitest 配置登记：静态导入、
  `configs`、`configModules`、`OFF_POOL_DEFAULT`）、
  `pnpm-lock.yaml`（重新生成）。
- 不动：channel 注册表、`ChannelBase`、所有现有适配器、review/serve 的
  Aone 代码路径。

## 风险与约束

- **a1 退出码会说谎**——每次读取都解析 JSON 形状；单仓库的权限错误
  （`SYSTEM_FORBIDDEN_ERROR`）使该仓库本轮轮询失败并退避，而非静默跳过；
  逐仓库隔离保证其余监听仓库继续轮询。
- **事件窗口丢失**——停机 > 3 天丢失更旧事件（v1 限制）。
- **洪水有界而非楔死**——积压 >1000 时走到窗口尾部、每轮派发最旧 100 条
  （余量后续排空）；只有超出平台 100 页可寻址窗口的积压才抛错。持续洪水
  若重于排空速率，老于 3 天窗口的事件仍会老化丢失——有界切片让 channel
  保持存活，丢失来自窗口而非静默的游标跳跃。
- **写一次性**——失败的评论创建会被浮现但绝不重试；瞬时写失败可能丢
  agent 回复（与 review provider 相同的取舍）。
- **共享主机认证**——channel 以主机上 a1 登录账号的身份行事。访问边界是
  `groupPolicy` 加 **GROUP** 发送者门禁（`groups[<repo>].senders` /
  `groups[<repo>].allowedUsers`）；顶层 `allowedUsers` 不作用于本 channel
  的 group 形态流量。随附配置示例在两层都收紧（allowlist）。

## 验证计划

- 单元测试（同目录，mock a1 exec 接缝）：触发匹配/剥离；游标基线/推进/
  校验/剪枝；派发过滤（自身/非 MR/无前缀）；exit 0 与 1 的错误对象处理；
  出站 argv；envelope 字段；翻页边界去重、满页第 10 页内命中游标即停、
  溢出走尾 + 有界最旧切片 + 排空推进、平台窗口防御性抛错；逐事件游标
  保存；失败隔离（派发失败后继续、跨仓库磁盘持久化、坏仓库在前不饿死
  后续）；view 负缓存；空模板回落；createdAt 不可解析诊断；descriptor
  groupPolicy 缺省。变异见证：去重、逐仓库隔离、溢出走尾、游标命中即停。
- 线上只读冒烟：真实 `a1 events repo middleware/tddl5` 拉取+解析，
  不派发、不写（环境变量门控）。
- 全链路 E2E（PATH 上打桩 a1： canned whoami/events；comment create
  记录 argv）：link 扩展、`qwen channel start`、一条触发事件 → 桩记录
  到 agent 回复。不写 Aone。
- 基线 dry-run：未装扩展的全局 `qwen` 拒绝类型 `aone`
  （`Channel type "aone" is not supported`，exit 1）。

## 验收标准

- `qwen extensions link packages/channels/aone` + 上述配置 → channel
  连接、基线化、把前缀触发的评论派发给 agent；回复作为一条 MR 评论落位
  （桩验证 argv）。
- bot 自身评论、非 MR 笔记、无前缀评论绝不派发。
- 重启从持久化游标恢复，不重派。
- a1 错误对象（exit 0 或 1）浮现为带退避的轮询错误；a1 二进制缺失时
  connect 以可操作消息失败。
- 构建、typecheck、本包单元测试通过；workspace 镜像元测试保持绿。

## 未决问题

- @mention 语法（`@account` 还是 `@花名`）：需一次线上写探针或 Web UI
  观察；后续 issue 素材。
- `--reply-to` 在行内评论根上的行为：未验证；后续项。
- Aone 评论大小限制（分段）：未知；v1 发单条评论。
- 多仓库轮询下 a1 后端的速率限制：未量化；缺省 60s 间隔把扇出保持在
  每仓库每轮一次 events 调用。
