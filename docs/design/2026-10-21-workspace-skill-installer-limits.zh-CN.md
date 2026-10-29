# 工作区技能安装器大小限制

[English](2026-10-21-workspace-skill-installer-limits.md) |
[简体中文](2026-10-21-workspace-skill-installer-limits.zh-CN.md)

## 状态

2026-10-21 提出，由本 pull request 实现。基线章节描述修改前的限制，
下文方案描述本次实现。合并与跨平台验证尚未完成。

## 问题

原生技能安装器会拒绝普通技能包。单个文件超过 2 MiB 即失败。第 129 个
文件即失败。GitHub 与本地文件夹安装在 6 MiB 处失败，即使这两个来源根本
不进入 JSON 请求体。

今天有两类约束被绑在一起，其中只有一类与 HTTP 有关：

- **传输。** `POST /workspace/skills/install` 把 ZIP 放在 JSON 的
  `source.contentBase64` 里。`packages/cli/src/serve/server/error-handlers.ts`
  使用 `express.json({ limit: '10mb' })` 解析该请求体。`bytes@3.1.2` 把
  `mb` 映射为 `1 << 20`，因此上限是 10,485,760 字节。超出的请求变成
  `413`，正文为 `Request body too large (max 10 MB)`，到不了安装器。
- **内存。** `SkillPackageFile.content` 是 `Buffer`。ZIP、GitHub 和文件夹
  都会把这些 buffer 积攒起来，再写入暂存目录。6 MiB 的未压缩上限就是这份
  堆预算，同时也阻止压缩包无界展开。GitHub 和文件夹的字节已经在网络或
  磁盘上，却仍要支付这笔预算。

`docs/design/web-shell/web-shell-skill-manager-page.md` 把文件数、单文件
大小、总大小、路径深度和路径长度描述为低于 daemon JSON 解析器上限。这句话
符合 commit `0ecba4b3c70`（PR #7018）引入的原始安装器。包不再整包留在内存
里之后，它不再适合作为 GitHub 和文件夹的上限。2 MiB 单文件和 128 个文件
没有更细的书面理由。

另一条技能下载路径已经允许大得多的获取。它不是这个安装器。这条路径仍把
每个文件放进 buffer 时，不能照搬对方的解压预算。见「修改前的基线」。

## 修改前的基线

`packages/cli/src/serve/workspace-skill-management.ts` 对所有来源使用同一
套预算：

| 常量              | 取值  | 约束对象                                                            |
| ----------------- | ----- | ------------------------------------------------------------------- |
| `MAX_FILES`       | 128   | ZIP 条目、GitHub 文件、文件夹文件，以及规范化之后的包               |
| `MAX_FILE_BYTES`  | 2 MiB | 单个 ZIP 条目、单次 GitHub 响应、单个文件夹文件，以及每个规范化文件 |
| `MAX_TOTAL_BYTES` | 6 MiB | 解码后的 base64、ZIP 未压缩字节、GitHub 合计、文件夹合计            |
| `MAX_PATH_LENGTH` | 512   | 相对路径和 GitHub 目录                                              |
| `MAX_PATH_DEPTH`  | 16    | 相对路径、ZIP 布局、GitHub 遍历和文件夹遍历                         |

`decodeBase64` 拒绝解码后大于 `MAX_TOTAL_BYTES` 的压缩包。`filesFromZip`
再把每个条目读进内存（`readZipEntry` 拼接 chunk），并再次套用同一单文件
和总大小上限。`fromBuffer` 在整个读取期间保留压缩包。
`downloadGitHubDirectory` 把每次 `fetchBytes` 的 buffer 推进 `state.files`。
git sparse-checkout 回退先把树检出到 `os.tmpdir()`，再由 `filesFromFolder`
读回 buffer。`filesFromFolder` 对每个文件 `readFile`，然后
`installWorkspaceSkill` 才把 buffer 写入既有暂存目录（技能父目录下的
`.skills-<name>.installing-*`）。合法包的堆峰值是整棵未压缩树；ZIP 路径还
要加上压缩包 buffer，以及请求结束前最多 10 MiB 的 JSON 正文。

`packages/web-shell/client/components/skills/SkillInstallDialog.tsx` 把
`MAX_SKILL_ZIP_BYTES` 设为 6 MiB，并在上传前拒绝该文件。
`packages/web-shell/client/i18n.tsx` 的两份文案是：

- `skills.install.error.zipTooLarge`：`The ZIP file must not exceed 6 MB.`
- 中文目录：`ZIP 文件不能超过 6 MB。`

对话框把服务端每一次 `skill_package_too_large` 都映射成这句 ZIP 文案，包括
未压缩总量超限的 GitHub 或文件夹包，以及超过 2 MiB 的单个文件。

大小失败使用 `skill_package_too_large`，HTTP 413。文件数失败使用
`invalid_skill_package`，HTTP 400（`Skill package has too many files`、
`Skill ZIP contains too many files`，空包则是
`Skill package has an invalid file count`）。daemon 文案不包含具体数字。

`workspace-skill-management.test.ts` 锁住了旧上限：
`stops reading an oversized GitHub Skill file`（2 MiB 再加 1 字节）、
`reports an expanded ZIP entry over the limit as too large`（一个 2 MiB
再加 1 字节的条目），以及
`reports a ZIP whose total expanded content is over the limit`（四个
1,600,000 字节的文件，约 6.4 MiB）。技能管理设计文档把这些称为 ZIP-bomb
限制。

`packages/cli/src/acp-integration/skill-source-download.ts` 是另一项功能。
它允许压缩 100 MiB（`MAX_SKILL_DOWNLOAD_BYTES`）、解压 500 MiB
（`MAX_SKILL_DECOMPRESSED_BYTES`）、API 文件 2000 个
（`MAX_SKILL_API_FILE_COUNT`）、深度 16（`MAX_SKILL_API_DIR_DEPTH`）。
膨胀一旦越过上限会被中止，但合法压缩包仍会 `Buffer.concat`，GitHub API
遍历仍保留每个文件的 buffer。这 500 MiB 可以留在 daemon 堆上。本安装器
不得采用那个解压数字。

Codex 仅作引用：`openai/codex` 的 `install-skill-from-github.py` 没有压缩、
未压缩、单文件或文件数上限。它把仓库 zip 或 git sparse checkout 复制到
磁盘，并拒绝路径逃逸、符号链接、非法技能名、已存在的目标，以及缺少
`SKILL.md`。`codex-rs/core-plugins` 的插件包允许远程下载 100 MiB、解压
512 MiB（PR #36485，2026-08-01，由 50/250 提高）。Share 与 npm 压缩包为
50 MiB，npm 解压为 250 MiB，解压时没有单文件或条目数上限。OpenAI 插件
提交门户允许 zip 最大 100 MB、单个成员最大 100 MiB、条目最多 5000、未压缩
最大 512 MiB、路径深度 20。其 `skill_bundle_too_large` 的具体数字未公布。
这些安装器不把解压后的树留在进程堆里。只要本路径仍缓冲每个文件，就不能
对齐它们没有上限的技能安装器，也不能对齐 512 MiB 的解压上限。

## 目标

- 把 ZIP 传输上限和磁盘上的包上限拆开。
- 提高单文件和文件数上限，使带有真实资源和真实参考目录的技能可以通过。
- 保留 zip bomb、路径、符号链接和暂存回滚行为。
- 避免在安装器堆中保留整个展开后的包，只保留流式缓冲及另有上限的清单读取。
- 用两种语言告诉 Web Shell 新的 ZIP 上限，并停止把每一次大小失败都说成
  6 MB 的 ZIP。

## 非目标

- 不新增上传协议。展开大小不再被压成与压缩包相同之后，JSON 正文已经能
  携带有用的源码 ZIP。放不进传输上限的二进制包走现有的 GitHub 或文件夹
  来源。
- 不修改 `express.json({ limit: '10mb' })`，也不提高全局 10 MiB 正文限制。
  该限制覆盖每一条 JSON 路由。
- 不修改 `packages/cli/src/acp-integration/skill-source-download.ts`。
  共享常量会把本路径拒绝的堆预算复制过来。
- 不增加用户设置、环境变量或按工作区覆盖。
- 不修改 `MAX_PATH_LENGTH`（512）或 `MAX_PATH_DEPTH`（16）。深度已经与
  `MAX_SKILL_API_DIR_DEPTH` 相同。
- 保留技能名规则、`SKILL.md` 名称匹配、符号链接拒绝、单层根目录剥离、
  暂存回滚，以及 GitHub 先 API 再 git 的回退行为，同时将实现适配到磁盘
  暂存。git 超时仍为 clone 60 秒、sparse-checkout 30 秒。
- 不改写 `docs/design/web-shell/web-shell-skill-manager-page.md`。该页没有
  中文版；改一句话就得整篇翻译。本文是大小限制的规格。旧句子描述的是
  #7018 交付的安装器。
- 不为安装增加并发限制，也不把 GitHub 路径改成一次归档下载。

## 方案

用两个上限替换 `MAX_TOTAL_BYTES`。提高单文件和文件数上限。把每个通过检查
的文件写入安装器已经会创建的暂存目录，再对写下去的字节套用包上限。

```text
MAX_ZIP_ARCHIVE_BYTES = 7_864_071
MAX_FILE_BYTES        = 32 * 1024 * 1024    // 33_554_432
MAX_PACKAGE_BYTES     = 64 * 1024 * 1024    // 67_108_864
MAX_FILES             = 2000
MAX_PATH_LENGTH       = 512                 // 不变
MAX_PATH_DEPTH        = 16                  // 不变
```

Web Shell 对话框里的 `MAX_SKILL_ZIP_BYTES` 等于 `MAX_ZIP_ARCHIVE_BYTES`。
对话框不能导入 CLI 模块。重复这个字面量。不要新增共享包。

### 传输上限

合规请求体是紧凑的 `JSON.stringify` 输出：

```json
{
  "name": "<256 chars>",
  "scope": "workspace",
  "source": { "type": "zip", "contentBase64": "<base64>" }
}
```

`name` 最长为 `MAX_WORKSPACE_SKILL_NAME_LENGTH`（256），字符集为
`[A-Za-z0-9._-]`，因此不会被 JSON 转义。`scope` 取更长的 `"workspace"`。
`contentBase64` 使用标准字母表，也不会被 JSON 转义。键顺序不改变长度。
`contentBase64` 为空时，这段信封是 330 字节。

```text
JSON_BODY_LIMIT_BYTES   = 10 * 1024 * 1024          // 10_485_760
ENVELOPE_BYTES          = 330
BASE64_BUDGET           = 10_485_760 - 330          // 10_485_430
MAX_ZIP_ARCHIVE_BYTES   = 3 * floor(10_485_430 / 4) // 7_864_071
```

编码后的正文是 330 + 10,485,428 = 10,485,758 字节，比解析器少 2 字节。
再多 1 个原始字节会多出 4 个 base64 字符（10,485,762 字节），在
`decodeBase64` 之前就被解析器拒绝。`decodeBase64` 仍对解码后的 buffer
执行 `MAX_ZIP_ARCHIVE_BYTES`，避免较短的名字把更大的压缩包送进安装器。
客户端在构造 base64 之前用同一个整数检查 `file.size`。

这大约是 7.50 MiB，只比 6 MiB 略高。ZIP 真正有用的变化不是这点提高。
小于 7,864,071 字节的文本型压缩包可以在磁盘上展开到 `MAX_PACKAGE_BYTES`。
不可压缩的压缩包做不到，那种包应使用 GitHub 或文件夹来源。

### 磁盘上的包上限

读取来源之前先创建现有的暂存目录。对每个接受的文件先按不变的规则校验
相对路径，再写入并丢掉正文：

- **ZIP。** 解码后的压缩包仍用 `fromBuffer`。该 buffer 最大为
  `MAX_ZIP_ARCHIVE_BYTES`。把每个条目 pipe 到暂存目录中的文件。累计字节。
  当 `entry.uncompressedSize` 或已读字节将超过 `MAX_FILE_BYTES` 或
  `MAX_PACKAGE_BYTES` 时，`destroy` 该条目流。不要对条目做 `Buffer.concat`。
- **文件夹。** 像现在一样 `lstat`，拒绝符号链接和特殊文件，然后 `copyFile`
  到暂存目录。不要对载荷 `readFile`。如果复制前后大小变化，则拒绝，与今天
  的长度检查一致。
- **GitHub API。** 把 `fetchBytes` pipe 到暂存文件。`content-length` 和
  流式总量都对照 `MAX_FILE_BYTES`，累计总量对照 `MAX_PACKAGE_BYTES`。
  越过上限时取消响应体。
- **Git sparse checkout。** 保留临时检出。用文件夹遍历把它复制进暂存目录。
  在现有的 `finally` 里删除临时检出。不要把检出读回 buffer 数组。

在消耗 `MAX_FILES` 或 `MAX_PACKAGE_BYTES` 之前跳过 `__MACOSX`、`.DS_Store`
和 `._*` 条目，并且不安装它们。今天 ZIP 的预检查会把这些垃圾计入上限，
之后 `normalizePackageFiles` 再丢掉。改完之后，上限描述的是实际安装的文件。

树写到磁盘之后，如果没有根级 `SKILL.md` 且所有文件共享同一个根，用 rename
剥掉这一层包裹目录。要求存在根级 `SKILL.md`。像现在一样从暂存文件解析
`SKILL.md`。任何失败都删除暂存目录并恢复备份，与现在相同。写入前后继续
调用 `assertGenerationOpen`，避免已关闭的 generation 留下技能目录。

暂存阶段保留的文件正文不随 `MAX_PACKAGE_BYTES` 增长
（之后的清单读取成本见「风险」）：

| 来源       | 留在堆上的内容                                                                              |
| ---------- | ------------------------------------------------------------------------------------------- |
| ZIP        | 处理函数返回前的 JSON 正文（≤ 10 MiB）、压缩包 buffer（≤ 7,864,071 字节），以及一个流 chunk |
| GitHub API | 目录列表加上一个流 chunk                                                                    |
| Git 检出   | 文件正文不留在堆上。Git 和 `copyFile` 走内核                                                |
| 文件夹     | 文件正文不留在堆上。`copyFile` 走内核                                                       |

重复路径检测仍需要一个路径集合。它保存的是字符串，不是文件内容。

### 单文件与文件数上限

`MAX_FILE_BYTES` 为 32 MiB。`MAX_FILES` 为 2000。二者都是磁盘限制，在流式
写入之前或期间执行。它们不是堆预留。

## 决策

**`MAX_ZIP_ARCHIVE_BYTES = 7_864_071`。** 这是在最坏合规信封下，仍能放进
10 MiB JSON 正文的最大原始 ZIP，计算见上。向下取整到 7 MiB 会浪费还能用的
字节。向上取整到 7.5 MiB（7,864,320）会让最长技能名在解析器里失败，并看到
笼统的 10 MB 错误。客户端与服务端使用同一个整数，文件选择器在上传前失败。

**`MAX_PACKAGE_BYTES = 64 MiB`。** 6 MiB 是旧的堆预算，却也加在已经位于
磁盘上的来源。文件流进暂存目录之后，这个上限是磁盘。64 MiB 够放下
`SKILL.md`、脚本，以及不止一个数 MiB 的资源（文档、wasm 模块、小型数据库、
图片）。它与 daemon 50 MiB 二进制上传（`packages/cli/src/serve/fs/policy.ts`
的 `MAX_UPLOAD_BYTES`）处于同一量级，但不借用那个常量：上传路由会缓冲正文，
本路径不能。另一条技能下载器和 Codex 插件解压所用的 100 MiB / 500 MiB /
512 MiB 是插件规模的树；在 Qwen 的另一条路径上，500 MiB 仍然是堆预算。
它们不是技能暂存预算。

**`MAX_FILE_BYTES = 32 MiB`。** 2 MiB 会在包的其余部分很小时拒绝一个普通
资源。32 MiB 允许一个 PDF、wasm 模块、SQLite 文件、字体或小型二进制辅助
程序。它是包上限的一半，第二个大资源必须放进剩余空间。写入使用流或
`copyFile`。进程不得为该文件分配 32 MiB 的 `Buffer`。
`skill-source-download.ts` 没有单文件上限可供对齐；若改成「无上限」，单个
条目会在没有单独提前拒绝的情况下向包上限增长，而 2 MiB 这个常量需要一个
仍然能挡住单条目 zip bomb 的替代值。

**`MAX_FILES = 2000`。** 参考目录加上脚本会在总字节仍然很小时超过 128 个
文件。2000 就是 `MAX_SKILL_API_FILE_COUNT`，即仓库内对同类 GitHub 目录
遍历的上限。这里它是安全的，因为安装器保留的是路径，不是 2000 个 buffer。
不采用门户的 5000，也不采用 Codex 不限文件数的复制。空包仍然失败于
`invalid_skill_package`。元数据文件不计数。

**流进现有暂存目录。** 若只提高 `MAX_TOTAL_BYTES` 并继续填满
`SkillPackageFile[]`，新的包上限就会钉在 daemon 堆上。64 MiB 已经占掉一个
小 worker 的大部分；若用另一下载器的 500 MiB，就是本设计拒绝的失败方式。
暂存目录、回滚，以及从磁盘解析 `SKILL.md`，都已经存在。实现改为更早写入
那里，并去掉内存中的整包数组。不新增另一种临时目录，也不新增路由。

**重试与清理隔离。** Contents API 失败后回退到 git 之前，就地清空暂存
目录，同时重置路径集合、文件数与字节数。暂存与备份目录名内嵌持有进程
的 pid，因此第二个守护进程会回收崩溃运行的残留，但不会删除活跃对等进程
的目录；进程内登记表覆盖从暂存目录创建之前到提交之后的窗口。清理安装
产物时匹配技能专属前缀后的完整后缀，安装 `foo` 不会误删
`foo.backup-1` 或 `foo.installing-abc123` 的暂存和备份。只有清扫真正
可能触及的请求名才以 `invalid_skill_name` 拒绝：以点开头且以
`.backup-` 或 `.installing-` 加 `[A-Za-z0-9-]` 结尾的名字，或者以技能
加载器本就跳过的双数字 `backup`/`installing` 后缀结尾的名字。
`release.installing-notes`、`db.backup-2024` 这类不带前导点的名字仍可
安装。本次不引入跨进程安装锁；路由互斥锁按解析后的技能目录加键，使
别名 scope 串行。

**保留一个大小错误码。** `skill_package_too_large`（413）仍覆盖压缩包、
单个文件和包总量。文案保持区分。文件数使用单独的错误码，以便 Web Shell
翻译。见「实现范围」。

## 约束

- 解析器上限是 10,485,760 字节，含等号。`body-parser` 只拒绝超过 `limit`
  的正文。
- 传输公式假定紧凑 JSON 和合法技能名。美化打印、附加字段，或发送会被
  JSON 转义的名字，仍可能收到笼统的解析器 413。官方客户端对
  `{ name, scope, source }` 做紧凑的 `JSON.stringify`，但提交前不检查
  名称长度上限。因此过长的名称仍可能先触发解析器，而非路由校验。
- `yauzl` 的 `fromBuffer` 需要整个压缩包。这笔开销由
  `MAX_ZIP_ARCHIVE_BYTES` 封顶，可以接受。本次不要另加把 ZIP 先落盘再读的
  读取器。
- GitHub Contents API 的目录列表在 API 的 1000 条目分页上限处停止。达到该
  长度的列表会被视为被截断，并改用现有 git 回退重新读取，因此，在 git
  传输能够完成认证的范围内（公开仓库，或已配置 git 凭据的主机），枚举
  完整性不依赖 API 遍历。对于只能凭已配置 API token 访问的私有仓库，
  达到或超过 1000 条目的列表在延期的回退认证落地之前没有可用的传输通道
  （见下一条 Git 凭据约束）。2000 个文件的 API 遍历仍可能很慢或触发速率
  限制。新的文件数上限不保证完成时间。SDK 请求和 Web Shell 操作当前都在
  30 秒后超时；客户端报告超时后，daemon 仍可能完成安装。取消机制与超时
  调整留作后续工作。
- Git 回退沿用现有 Git 环境和凭证助手，不向 Git 子进程注入配置的 API token。
  私有仓库回退认证留待后续处理，需要限定凭证主机、保留继承配置，并覆盖
  延迟拉取文件内容的路径。这一延期是上述 ≥1000 条目列表路径的正确性边界，
  而不只是增强项。
- Web Shell 与 CLI 没有可供这个常量共用的模块。两个字面量必须在评审时保持
  相等。
- 不单独限制 ZIP 压缩比。压缩包和展开字节上限分别生效，高压缩比的包
  也适用这两个独立上限。

## 风险

**如果跳过流式写入，堆会涨。** 只改新常量、仍保留 `SkillPackageFile.content`
数组，会使每次进行中的安装持有最多 64 MiB 文件正文，再加上最多 7,864,071
字节的 ZIP，再加上 10 MiB JSON 正文。并发安装会倍增。本设计不掩盖这笔
成本。如果在新上限下整包仍然留在这些 buffer 里，实现就是错的。

**ZIP 路径上仍然存在的堆。** ZIP 安装在处理函数结束前仍持有 JSON 文本和
解码后的压缩包。二者合计最多是 10 MiB 的 JSON 正文加上 7,864,071 字节的
压缩包，再加一个流 chunk。清单校验还会把整个 `SKILL.md`（最多 32 MiB）
读成字符串，后续技能加载也会整份读取。流式写入消除了整包正文的保留，
并未消除清单的内存成本。不要把任何来源描述成不分配内存。

**磁盘。** 暂存目录最多可放 64 MiB，rename 之后这就是已安装的技能。替换
已有技能时，旧树的备份会短时间同时存在。git 回退在 `finally` 删除检出之前，
会短时间同时保留临时检出和暂存副本。检出本身不受安装器上限约束：git
先将文件落盘，随后复制时才检查大小。达到 1000 条目分页上限的列表会让
最大的那些目录确定性地走这条路径，因此不受限的检出成本不再只出现在
429/5xx 重试时。128 MiB 仍然不是磁盘占用上限。
失败的安装仍必须
删除暂存目录。越过上限的半截条目只能留在该暂存目录内。

**被拒绝的安装可能留下基础目录。** 技能基础目录在获取来源之前创建，因此
来源文件夹不存在、GitHub 404，或 ZIP 解码失败时，失败发生在
`<workspace>/.qwen/skills`（或全局对应位置）已经存在之后。只有非法 base64
的 ZIP 形状会在创建目录之前被拒绝。留下空目录是有意为之：暂存目录必须与
目标同盘，最后的 rename 才能不跨文件系统。

**如果错误映射不改，界面会误导。** 今天的 ZIP 句子对 GitHub、文件夹和单文件
失败已经是错的。只把它改成 7,864,071 字节、却不单独写包大小的句子，这个
错误还会留下。

**Generation 关闭。** `does not create Skill directories after the generation
closes` 在第三次 `assertGenerationOpen` 时抛出，并期望不存在 `.qwen` 目录。
调整写入顺序后，不能留下 `.qwen` 或暂存目录。调用序列变化时更新检查序号；
保持这个可观察结果。

## 实现范围

只改这些文件：

- `packages/cli/src/serve/workspace-skill-management.ts`
- `packages/cli/src/serve/workspace-skill-management.test.ts`
- `packages/cli/src/serve/workspace-skill-management-recovery.test.ts`
  （新增；Contents API 失败后的重试与暂存重置，以及安装产物前缀碰撞的隔离）
- `packages/web-shell/client/components/skills/SkillInstallDialog.tsx`
- `packages/web-shell/client/components/skills/SkillInstallDialog.test.tsx`
  （新增大小与文件数错误码的用例行）
- `packages/web-shell/client/i18n.tsx`（英文和中文两份目录）

不要改 `error-handlers.ts`、`workspace-skills.ts`（路由只原样传递
`contentBase64`）、`skill-source-download.ts`、SDK 类型，或全局 JSON 限制。

### 行为

- 解码后的 ZIP 大于 7,864,071 字节：`413 skill_package_too_large`，文案
  `Skill ZIP exceeds the allowed archive size`。
- 单个文件或 ZIP 条目超过 32 MiB：`413 skill_package_too_large`。保留现有
  句子（`Skill file is too large`、`Skill file is too large: <path>`、
  `Skill ZIP entry is too large: <name>`、
  `Skill ZIP entry exceeds the allowed size`）。
- 已安装字节超过 64 MiB：`413 skill_package_too_large`。保留
  `Skill package exceeds the allowed size` 和
  `Skill ZIP expands beyond the allowed size`。
- 已安装文件超过 2000 个：`400 skill_too_many_files`。文案：
  `Skill package has too many files (max 2000)` 和
  `Skill ZIP contains too many files (max 2000)`。
- 写入暂存目录时抛出写入故障（errno 为 `ENOSPC`、`EDQUOT`、`EROFS`、
  `EIO`、`EMFILE`、`ENFILE`、`EBUSY`、`EACCES`、`EPERM`）：
  `500 skill_staging_failed`。文件夹复制需区分歧义 errno：Node 对每次
  `copyFile` 失败都会同时报告来源 `path` 与目标 `dest`，因此 `EACCES`
  和 `EPERM` 只在来源仍可读时映射为 500；`EIO` 等读写皆可能的 errno
  保持按来源映射为 400/502。直接的暂存写入（`open`、`write`、`mkdir`）
  无条件把 `EACCES` 和 `EPERM` 映射为 500。暂存文件在 finalize 前消失
  同样为 `500 skill_staging_failed`。
- 空包、非法路径、重复路径和过深目录：`invalid_skill_package` 的文案和
  HTTP 400 不变。
- ZIP 条目无论先后顺序，只要同一条路径既作为文件又作为目录出现：
  `400 invalid_skill_package`，文案为
  `Skill package has conflicting file and directory entries: <路径>`，
  其中 `<路径>` 是后出现的条目。
- 展开后超过 6 MiB、但仍在新上限内的文件夹或 ZIP 可以安装。2 MiB 再加
  1 字节的文件可以安装。
- 路径长度、深度、符号链接、加密、绝对路径和 `..` 的拒绝行为不变。
- Web Shell 文件选择器：`file.size > 7_864_071` 时显示
  `skills.install.error.zipTooLarge`，并且不上传。
- Web Shell 收到服务端 `skill_package_too_large`：显示
  `skills.install.error.packageTooLarge`，不显示 ZIP 句子。
- Web Shell 收到服务端 `skill_too_many_files`：显示
  `skills.install.error.tooManyFiles`。
- 其他 `invalid_skill_package` 仍使用
  `skills.install.error.invalidPackage`。

### 文案

`skills.install.error.zipTooLarge`：

- 英文：`The ZIP file must not exceed 7,864,071 bytes.`
- 中文：`ZIP 文件不能超过 7,864,071 字节。`

`skills.install.error.packageTooLarge`：

- 英文：`The skill exceeds the installer limit of 32 MiB per file or 64 MiB total.`
- 中文：`技能超过安装限制：单文件最大 32 MiB，合计最大 64 MiB。`

`skills.install.error.tooManyFiles`：

- 英文：`The skill package has too many files (max 2000).`
- 中文：`技能包文件过多（最多 2000 个）。`

删掉现在这两句带 `6 MB` 的文案。界面不要把 7,864,071 字节说成 7.5 MiB：
7.5 MiB 是 7,864,320，会比服务端多接受 249 字节。

在 `MAX_ZIP_ARCHIVE_BYTES` 旁用简短注释写明信封公式，否则这个数字无法解释。
另有两处 why 注释计入预算：一处说明 Contents API 分页上限，一处说明
`liveInstallArtifacts` 不变量。除此之外不新增注释。

## 验证

更新 `packages/cli/src/serve/workspace-skill-management.test.ts`，以及新增的
`packages/cli/src/serve/workspace-skill-management-recovery.test.ts`。设计阶段
不跑完整测试套件；实现 PR 跑这两个文件。

- 断言 `MAX_ZIP_ARCHIVE_BYTES` 等于上面的公式，并且最坏信封加上这么多字节的
  base64 后 ≤ 10,485,760，再多 1 个原始字节则超出。为该断言导出常量，或者
  在它已经导出时从模块断言。不要为了配置而导出。
- 反转 `reports an expanded ZIP entry over the limit as too large`：2 MiB
  再加 1 字节的条目应当安装成功。
- 反转 `reports a ZIP whose total expanded content is over the limit`：
  四个 1,600,000 字节的文件应当安装成功。
- 替换 `stops reading an oversized GitHub Skill file`：没有 `content-length`、
  正文为 2 MiB 再加 1 字节时，低于新的单文件上限。`content-length` 为
  `MAX_FILE_BYTES + 1` 的响应返回 413，且不需要 32 MiB 的正文。一段流式正文
  达到 `MAX_FILE_BYTES + 1` 字节时仍返回 413 并取消读取。这一次测试可以分配
  32 MiB 再加 1 字节。不要再分配 64 MiB。
- 文件夹：`fs.truncate` 造出的 `MAX_FILE_BYTES + 1` 稀疏文件返回 413。大小
  之和为 `MAX_PACKAGE_BYTES + 1` 的稀疏文件返回 413。这两个测试不应在测试
  进程里分配对应的 buffer。
- 文件夹或 ZIP：129 个小文件可以安装。2001 个小文件返回
  `skill_too_many_files`。
- 文件夹中 2 MiB 再加 1 字节的文件可以安装。
- 现有的符号链接、路径穿越、清单和回滚测试保持通过。
- `does not create Skill directories after the generation closes` 仍然不留下
  技能目录。需要时调整它的检查序号。

现有 Web Shell 测试中没有断言 6 MB 这句文案的用例
（`SkillsManagerPage.test.tsx` 没有）。界面改动包括两份 i18n 目录、对话框
常量，以及 `SkillInstallDialog.test.tsx` 中新增的错误码用例。不必为此新增
浏览器套件。

实现 PR 运行聚焦的安装器测试、针对对话框和 i18n 改动的 Web Shell
typecheck，以及对所改包的 `npm run typecheck`。不需要超出这些测试的新 E2E
计划：行为仍是同一条安装流程，只是上限变了。把这一点记在 PR 的测试说明里。

## 验收标准

1. `workspace-skill-management.ts` 使用的就是上面四个常量。
   `MAX_TOTAL_BYTES` 消失。`MAX_PATH_LENGTH` 和 `MAX_PATH_DEPTH` 不变。
2. `MAX_SKILL_ZIP_BYTES` 为 7,864,071。两份 i18n 目录使用本文的字符串。
   两份目录都不再对这个错误保留 `6 MB`。
3. 评审人可以用 10 MiB 减去 330 字节信封复算 7,864,071。全局 JSON 限制仍是
   `10mb`。
4. GitHub 和文件夹安装写入现有暂存目录，且不保留装满文件正文的
   `SkillPackageFile[]`。ZIP 展开把条目流 pipe 到文件。压缩包 buffer 仍然
   存在，并由 `MAX_ZIP_ARCHIVE_BYTES` 限制。
5. 超过 6 MiB、但处于 64 MiB、单文件 32 MiB、2000 个文件以内的包，可以从
   文件夹和 ZIP 安装。越过其中任一上限时，返回本文的状态码和错误码，并且
   不留下暂存目录或部分技能。
6. 符号链接、路径逃逸、深度、路径长度、清单检查和回滚与现在一致。
7. `skill-source-download.ts` 和 `error-handlers.ts` 没有 diff。
8. 旧的技能管理设计文档不动。它若仍写所有大小都低于 JSON 解析器，安装器
   限制以本文为准。

## 待定问题

没有。上限，以及流进现有暂存目录这一决定，都已确定。如果新的文件数上限使
Contents API 遍历太慢，后续可以再把 GitHub 安装改成一次归档下载。那不是
本次变更的前提。
