# 文件历史：原子备份发布

[English](2026-11-11-file-history-atomic-backup.md) | [简体中文](2026-11-11-file-history-atomic-backup.zh-CN.md)

状态：已实现并验证（issue #16896 试点，将 `v1.0.0-preview` @ `587e3429cabf`
的崩溃安全捕获移植到 main 现有文件历史）。已在基线 commit 上以故障注入复现、
修复，并于 2026-11-11 通过回归套件与交互式 E2E 验证。

## 问题

`packages/core/src/services/fileHistoryService.ts` 的 `createBackup` 把工作
文件**直接复制到最终备份路径**（经 `safeCopyFile` 的 `copyFile`），随后对最终
路径 `chmod`。两种失败模式会在「后续读取视为有效检查点」的路径上发布不完整
内容：

1. **捕获中断。** `copyFile` 期间进程崩溃或 I/O 错误，会在最终备份路径留下
   截断 blob。
2. **并发覆盖已被引用的备份。** 备份名是确定性的
   （`sha256(path)[0:16]@vN`），且 `trackEdit` 明确允许并发调用写同一路径
   （「第二个无害地覆盖第一个」）。这只有在两次复制都完成时才无害：若进程在
   第二次复制期间崩溃，blob 被截断——**而此时已有确认的快照条目引用它**。

恢复会话后，`validateRestoredSnapshots` 只对引用的备份做 `stat`——截断 blob
能通过校验。随后 `checkOriginFileChanged` 发现大小/内容不一致，`rewind` 把
截断内容当作捕获的检查点恢复：在一个以可靠撤销为全部目的的功能里，这是静默
的错误恢复。

## 现状

main 的捕获流程（`createBackup`）：

1. `stat(filePath)`；ENOENT → 记录 `null` 备份（文件当时不存在）。
2. `safeCopyFile(filePath, backupPath)`——直接 `copyFile` 到最终路径，带
   ENOENT 歧义消解：源文件消失 → `'src-missing'`；目标目录缺失 → `mkdir` 后
   重试。
3. `chmod(backupPath, srcStats.mode)`。
4. 返回 `{ backupFileName, version, backupTime }`。失败时抛错；`trackEdit`
   吞掉错误（不记录任何条目），`makeSnapshot` 记录 `failed: true` 条目，
   `rewind` 通过 `filesFailed` 暴露这些路径。

preview 分支（`packages/core/src/file-history/file-history.ts`）已解决此问题：
以 `COPYFILE_EXCL` 复制到 `${backupPath}.tmp`，对临时文件 `chmod`，再
`rename` 到位，失败时删除临时文件。preview 能用固定 `.tmp` 后缀，因为其备份
名是 UUID；main 的确定性命名需要适配（见下文）。

## 目标

- 捕获期间的崩溃或 I/O 错误绝不在最终备份路径留下不完整内容。
- 失败继续通过现有 `failed` / `filesFailed` 语义暴露——不新增标记、不改调用方。
- 针对 `copyFile` / `chmod` / `rename` 的故障注入回归测试。
- 评估逐快照 `cwd` 项并以证据关闭。

## 非目标（来自 issue #16896）

- 用 preview 的 `FileHistoryManager` 替换 `FileHistoryService`。
- UUID 备份命名（main 的 `hash@version` + 最大版本号扫描已避免冲突）。
- 重复移植 `captureFailed` / 逐文件 rewind 失败报告（main 已有
  `failed` / `filesFailed`）。
- 会话 fork 的备份迁移（硬链接复制）。
- 留存存储捕获路径（`packages/cli/src/serve/managed-csi-file-backend.ts`
  单独实现 `RetainedFileHistoryStorage.createBackup`）；本变更不触及它。

## 方案

只改 `packages/core/src/services/fileHistoryService.ts` 的 `createBackup` 与
`safeCopyFile`：

1. `safeCopyFile` 增加可选 `mode` 参数（默认 `0`，即 `copyFile` 的默认值），
   使独占标志对首次尝试与 `mkdir` 后的重试都生效。`restoreBackup` 继续不带
   mode 调用——恢复行为不变。
2. `createBackup` 原子发布：
   - `temporaryPath = `${backupPath}.${randomUUID()}.tmp``——每次调用**唯一**
     的临时名。
   - `safeCopyFile(filePath, temporaryPath, constants.COPYFILE_EXCL)`——独占
     复制；`'src-missing'` 仍返回 `null` 备份，并尽力 unlink 临时文件（复制
     可能在源文件消失前已创建它）。
   - `chmod(temporaryPath, srcStats.mode)`——权限在发布**之前**设置。
   - `renameWithRetry(temporaryPath, backupPath, 3, 50)`——同目录/同文件系统
     上的原子发布，复用 `utils/atomicFileWrite.ts` 的共享助手（见下文）。
   - 任何失败：`unlink(temporaryPath)`（忽略 ENOENT，其他清理错误记日志），
     然后重新抛错，沿用调用方现有的 `failed` 语义。

`stat`-ENOENT 提前返回、`'src-missing'` 歧义消解、确定性最终名、抛错契约全部
保留。

## 设计决策与理由

### 唯一临时后缀，而非 preview 的固定 `.tmp`

main 的最终备份名是确定性的，同一 `(file, version)` 的并发捕获是代码明确承认
并支持的场景。若共享 `${backupPath}.tmp`：

- 第二个并发 `copyFile(..., COPYFILE_EXCL)` 会以 `EEXIST` 失败；
- 更糟的是，任一调用的失败清理会删掉另一调用正在写入的临时文件，把无害竞争
  变成相互失败。

每次调用一个 `randomUUID()` 后缀让并发捕获彼此独立：各自发布完整副本，
`rename` 使最后一个生效——正是今天「第二个无害地覆盖第一个」的语义，只是去掉
了截断窗口。保留 `COPYFILE_EXCL` 作为「不覆盖已存在临时文件」的廉价防线。

### 失败契约不变

preview 的 `createBackup` 返回 `unavailableBackup` 记录；main 的抛错并由调用方
记录失败（`trackEdit`：吞掉 + 不记录；`makeSnapshot`：`failed: true` 条目）。
移植保留 main 的契约，因此调用方、序列化格式、rewind/diff 路径均不变。

### 发布 rename 复用 `renameWithRetry`

仓库的原子发布惯例（`atomicWriteFile`、`mods/store.ts`、`extension-store.ts`、
workflow journal）都经 `utils/atomicFileWrite.ts` 的 `renameWithRetry` 发布：
瞬态 `EPERM`/`EACCES`（Windows 并发访问或杀毒扫描下常见）以指数退避重试
（3 次重试、50 ms 基数）；其他错误立即重抛。裸 `rename` 会把可吸收的瞬态锁
变成一次丢失的捕获（`makeSnapshot` 记 `failed: true`；`trackEdit` 不记录）。
移植复用该助手，参数与 `mods/store.ts` 相同的 `(3, 50)`，使发布步骤与惯例
一致，同时保留上面的不可重试失败契约。整函数复用 `atomicWriteFile` 不合适：
它接收 `string | Buffer` 内容，没有 `'src-missing'` 哨兵、没有目标目录
`mkdir` 重试、也没有 `COPYFILE_EXCL` 源复制。

### 孤儿临时文件

复制与 rename 之间崩溃会在会话备份目录留下 `<name>.<uuid>.tmp`。孤儿永不被
任何快照引用，对 `validateRestoredSnapshots` 不可见（它只 stat 被引用的名字），
并由既有清扫移除：会话删除（`sessionService.removeFileHistoryBackups` 删除
整个会话目录）与 housekeeping（`cleanupOldFileHistoryBackups` 按 mtime 清扫
会话目录）。不新增清扫器。

### 逐快照 `cwd`：已评估，无需改动

issue 要求**仅在确认 enter/exit worktree 存在真实错误恢复缺陷时**才记录每个
快照产生时的 `cwd`。对试点基线 commit 的 main 的调查表明不存在该路径：

- `EnterWorktreeTool.execute` 创建 worktree 并指示模型把一切文件操作路由到其
  绝对路径；它从不改变 `Config.cwd`。`ExitWorktreeTool` 同样从不 relocate。
  TUI 的 sidecar 监听（`useWorktreeSession`）仅用于展示。
- 由于 `FileHistoryService.cwd` 在 enter/exit 间恒定，跟踪路径（相对不变 cwd
  的相对路径，如 `.qwen/worktrees/<slug>/file.txt`；或 cwd 之外文件的绝对
  路径）在恢复时展开回同一绝对路径。
- `--worktree` 启动标志在 Config 构造**之前** chdir，该会话的 cwd 从一开始
  就是 worktree——同样一致。
- ACP 托管会话直接拒绝 `enter_worktree` / `exit_worktree`；独立 ACP 路径使用
  同样的不 relocate 的工具。

因此逐快照记录 `cwd` 不会为 enter/exit worktree 增加任何正确性。该项以
「已评估、无需改动」关闭。

相邻观察（超出试点范围，候选后续项）：`/cd`（`cdCommand`）与 ACP `session/cd`
调用 `relocateWorkingDirectory`，它重置 `fileHistoryService` 但不动
`sessionData`；随后惰性的 `getFileHistoryService()` 会把
`sessionData.fileHistorySnapshots`（resume 时载入的载荷）按**新** cwd 重新
水合。在已 resume 的会话里，rewind 到 `cd` 之前的检查点可能把相对跟踪路径恢复
到新目录下。这是目录 relocate 问题，不是 worktree enter/exit 问题；记录在此
供单独立项，本试点不改动。

## 约束

- 临时文件与最终路径同目录，因此 `rename` 同文件系统（无 `EXDEV`）且在 POSIX
  上原子。Windows 上 Node 的 `rename` 替换已存在的目标（`MoveFileExW` 带
  `MOVEFILE_REPLACE_EXISTING`），保留并发「最后生效」行为；并发访问或杀毒
  扫描造成的瞬态 `EPERM`/`EACCES` 由 `renameWithRetry` 的退避吸收（最坏增加
  350 ms 延迟）。
- `resolveBackupPath` 的目录逃逸防护不变；临时名在内部派生，绝不来自用户输入。
- ESM、严格 TypeScript、无 `any`；注释只加在 why 不显然处（唯一后缀的并发
  不变式）。

## 风险

- **反复崩溃后的孤儿累积**：受既有会话删除与 housekeeping 清扫约束；每个孤儿
  至多一个备份的大小。
- **并发 `rename` 到同一最终路径**：最后一个完整副本生效——与今天并发
  `copyFile` 的结果一致，只是没有截断窗口。
- **清理失败**（如备份目录权限翻转）：记日志并吞掉；原始捕获错误仍向上传播，
  失败报告不受影响。孤儿稍后被清扫。
- **掉电持久性不在范围内**：临时文件发布前不做 `fsync`，与 preview 参考一致。
  掉电（区别于进程崩溃或 I/O 错误）若发生在文件系统回写窗口内，某些文件系统
  上仍可能暴露过期或零长备份。修复前的代码有同样的暴露；本变更关闭的是大得
  多的进程崩溃窗口。加 `fsync`（如 `atomicWriteFile` 与 mod store 所做）是
  候选后续加固，需权衡其给每次备份增加的延迟。

## 验证计划

1. **故障注入单测**（对齐 preview 的 `file-history.test.ts`，适配 main 语义）：
   对 `copyFile`（先写部分内容再抛错）、`chmod`、`rename`（各拒绝一次）：
   - `trackEdit` 正常 resolve 且不记录任何条目；备份目录保持为空（无最终
     blob、无临时残留）；工作文件未被改动。
   - `makeSnapshot` 记录 `failed: true` 条目；`rewind` 通过 `filesFailed`
     报告该文件；仍然没有任何内容被发布。
2. **旧检查点保留**：版本 N+1 的失败捕获不破坏完整的版本 N blob，后者仍可
   rewind。
3. **并发捕获崩溃**：两个同时的 `trackEdit` 竞争同一确定性路径，第二次复制
   中途被打断。已确认条目的 blob 保持完整内容，且
   serialize → resume → validate → rewind 一圈后恢复的是真实检查点
   （即 issue 的静默错误恢复场景）。
4. **并发捕获（成功）**：同一文件的两个同时 `trackEdit` 都成功，恰好发布
   一个完整备份，且不留下临时文件（钉住唯一后缀适配）。
5. **权限**：发布的备份携带源文件的 mode。
6. **源文件消失竞态**：源文件被删除后 `copyFile` 以 ENOENT 失败 → 记录
   `null` 备份，不发布任何内容。含复制中途变体：复制已创建部分临时文件后
   源文件消失 → 临时文件同样被清理。
7. **rename 重试语义**：单次瞬态 `EPERM` rename 被重试并发布完整备份；
   持续 `EPERM` 耗尽重试后按失败捕获暴露，不发布任何内容。
8. **既有套件**：`fileHistoryService.test.ts` 与留存存储套件保持绿
   （`safeCopyFile` 的 mode 参数默认即今天的行为）。
9. `npm run build && npm run bundle && npm run typecheck`、聚焦 vitest，
   以及按 `.qwen/e2e-tests/` 测试计划做一次交互式 E2E 冒烟（tmux 捕获 +
   rewind）。E2E 仅限交互模式：文件检查点默认 `!sdkMode && interactive`，
   headless 运行在两个二进制上都不捕获快照（既有门控）。

## 验证结果（2026-11-11）

- 复现：4 个故障注入探针在基线 commit 上失败，包括端到端的静默错误恢复
  （rewind 报告 `filesFailed: []` 却写入截断字节）。
- 正式套件 `file-history-atomic-backup.test.ts`（15 个用例）在修复后全部
  通过。变异臂对最终套件复跑：把 `createBackup` 回退为直接复制 11/15 失败
  （4 个幸存者是行为保持用例——瞬态 EPERM 重试、并发成功、权限、复制前源
  消失——按设计在两种实现下都通过）；retries=0 变异使瞬态 EPERM 用例变红；
  删除源消失临时清理使复制中途清理用例变红。
- 聚焦回归：8 个 file-history 相关文件的 508 个 core 用例、2 个消费者文件
  的 81 个 cli 用例通过；build、bundle、typecheck 通过。
- 交互式 E2E（tmux，`node dist/cli.js` 对比全局 qwen 0.27.2 基线）：只发布
  完整备份、`<16-hex>@vN` 命名、字节精确、mode 保留、`@v2` 不扰动 `@v1`、
  零 `*.tmp` 残留、`/rewind` 干净恢复。
- 代码评审（medium，已验证）：0 Critical、1 Suggestion——发布 rename 应复用
  共享助手 `renameWithRetry` 而非裸 `rename`（探针证实：一次性 `EPERM` 下
  裸 rename 丢失捕获，助手则成功）。已采纳并应用，新增两个回归用例（瞬态
  `EPERM` 重试成功；持续 `EPERM` 耗尽后走 failed 契约）。
- PR 后多轮审计（无方向 + 对抗，真实探针）：把直接复制变异计数更正为复测
  的 11/15；以尽力清理 + 钉住用例关闭源消失复制中途的孤儿边界；探针验证
  最终路径被目录占据（EISDIR → 诚实的 failed 条目，不发布任何内容）、只读
  备份目录（EACCES 向上传播，不发布任何内容）、目录源文件（不发布任何
  内容）；记录上述掉电持久性限制。两个红 CI job 定性为基础设施：shard 2/2
  的 29/29 测试文件全绿，仅在测试后临时 HOME 的 `rm` 清理步骤失败；
  No-Sandbox job 是传播该结果的聚合门。

## 验收标准

- 没有任何代码路径在最终备份路径发布不完整内容。
- `copyFile` / `chmod` / `rename` 失败通过现有 `failed` / `filesFailed` 语义
  暴露，且临时文件被清理。
- 同一确定性路径的并发捕获仍然无害。
- `cwd` 评估项以上述证据关闭。
- 双语设计文档与回归测试在同一变更内落地。

## 开放问题

无。`cwd` 项已按「已评估、无需改动」解决；`/cd` 水合观察推迟到单独 issue。
