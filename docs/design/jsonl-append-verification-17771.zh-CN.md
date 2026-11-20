# Legacy JSONL 追加隔离：#17771 合入验证记录

[English](./jsonl-append-verification-17771.md) | [简体中文](./jsonl-append-verification-17771.zh-CN.md)

**状态：已合入（Merged）。**本文是合入后的验证账本，不是另一套追加架构的提案。
除下文单独标明的 CLI 出处补充验证外，以下内容是 #17771 的历史验证记录，
而非本次纯文档变更对它们的重新验证。

## 状态与出处

- Pull request：#17771。
- Squash commit：`f8fa7c476f2244d5c6832fb2bb9a551882c425b3`。
- 比对的 PR head：`78489a70bda7e0d85f203c762aaa67d28b790410`。
- 四个变更文件均已逐文件比较该 PR head 与 squash commit 的字节内容，全部一致：

```text
packages/core/src/utils/jsonl-utils.ts
packages/core/src/utils/jsonl-utils.test.ts
packages/core/src/utils/debugLogger.ts
packages/core/src/utils/debugLogger.test.ts
```

- `packages/core/src/utils/jsonl-utils.ts` 实测的 SHA-256 为
  `9ea6a9debcb58352dec0e0b0c94c3ee533b9189d2354bbf979ac921ff2922754`。
- 保留的历史快照包含 62 项检查，最近包含的检查完成于
  `2026-11-19T12:54:21Z`。发布于 `2026-11-19T13:02:01Z` 的收尾评论记录了该快照中的
  **28 passed、34 skipped、0 failed、0 cancelled、0 pending**。后续附着的自动化
  不在这个快照内；这些不是按当前聚合重新计算的数字。skipped 不能作为更多平台或
  功能覆盖的证据。
- 合入后的 main CI [run 44540717712](https://github.com/QwenLM/qwen-code/actions/runs/44540717712)
  还发生过另一项独立的 i18n 测试失败，缺少的是
  `settings.label.experimental.mods` 和 `settings.description.experimental.mods`
  的 ru 条目。它不是 JSONL append 回归，也不在前述 PR-head 快照的统计范围内。
  既有的 [#17847](https://github.com/QwenLM/qwen-code/pull/17847) 单独跟踪这项
  locale 问题，目前已闭合且 `mergeCommit: null`。本文不把该提议的 locale 修复
  或主线 CI 记为已经验证。

## 已交付行为

以下范围以当前源码为准，而不是以较早的评审中间版本为准：

- `writeLine` 和 `writeLineSync` 通过添加必需的记录分隔符，将中断产生的、未以
  换行结束的尾部与下一条完整 JSON 记录隔离。
- 原有残缺字节保持原位。该操作只追加，不解析、修复、重新序列化或改写历史。
  普通 regular file 的既有字节在其他方面保持不变。
- 无法检查 regular file 尾部时，只有 `EACCES`、`EPERM`、`EAGAIN`、满足
  `permission === 'FileSystemRead'` 的 `ERR_ACCESS_DENIED`，以及 `win32` 上的
  `EBUSY` 才使用保守的 `\n`。`ENOENT` 则重新打开 append handle 并检查它。其他
  错误（包括 `EIO` 和非读取权限拒绝）直接传播，不执行该回退追加。
- non-regular 路径不会获得临时的只读 tail-probe reader，以免消耗外部 payload。
  实现打开真正的 `a` writer，检查已打开 handle 的类型，并通过该 writer 追加。
- 生命周期取决于路径的检查方式。已存在且可读取的 regular file 使用 tail probe，
  检查后关闭探测句柄；真正的 append 再通过 pathname 并使用 `flush: true` 执行。
  此时 `openAppender` 为 `undefined`，可选的 `openAppender?.sync()` 与
  `openAppender?.close()` 不会执行。允许列表中的 tail-read fallback 同样通过
  pathname 追加，不保留显式 append handle。
- 只有因 `ENOENT` 或 non-regular 路径而实际打开、并经 `FileHandle.stat`/`fstat`
  校验的 append handle 才保持打开，供真正的 append 使用。随后 async 显式调用
  `sync()` 并关闭该 handle；sync 通过已校验的 descriptor 以 `flush: true` 追加，
  再关闭该 descriptor。append、同步和关闭失败不会被转成成功。
- 无活动 debug session 或禁用文件输出时，`warnWithDelivery` 不尝试
  `fs.appendFile`，直接报告 `delivered=false`。实际尝试 debug append 时，
  交付只由真实的 debug `fs.appendFile` 结果报告，不由前置目录操作决定。
  抛错的 delivery observer 被单独处理，不等同于文件系统写入失败。

这里不宣称跨平台或所有特殊文件上的通用行为，不宣称通用 FIFO transcript 支持，
也不宣称通用跨进程锁协议。

## 聚焦验证

已记录为通过的 gate 精确如下：

```bash
(cd packages/core && npx vitest run src/utils/jsonl-utils.test.ts src/utils/debugLogger.test.ts)
npm run build
npm run typecheck
npm run bundle
```

子 shell 仅在 `packages/core` 内运行聚焦 Vitest，随后三条根级命令仍在仓库根目录
执行。

- 聚焦结果：**150/150 tests**，其中 `jsonl-utils.test.ts` 为 **107** 项，
  `debugLogger.test.ts` 为 **43** 项。
- 真实根 build、完整根 typecheck 和 CLI bundle 均以 `0` 退出。
- 只有这些是已验证的 gate；它们不代表全仓测试运行全绿。

负向变异同样重要：去掉 `previous.pending` 守卫后，async 与 sync 的
pending-delivery 去重相关用例确实失败。恢复守卫后，聚焦集合恢复为 150/150。
这是变异证据，而不只是声称未修改的测试通过。

## 原生与故障注入证据

原生测量使用 Linux 和 Node `22.23.4`。故障注入单独标明，不会被写成操作系统原生
产生的错误。

- **FIFO，原生：**四个 appender/native 场景都保留外部 payload，没有创建临时
  tail-probe reader，并保持原生 `fsync` 错误语义。这不能证明通用 FIFO transcript
  语义。
- **Lease，原生：**在真实 Linux `F_SETLEASE`/`F_WRLCK` 下，旧 appender 遇到
  `EAGAIN` 且没有追加。当前 appender 保住下一条完整记录，native control 也保持
  预期行为。
- **类型替换，原生时序：**`ptrace` 观察到 `stat` 成功后，将目录替换为 torn
  regular file，结果精确为 `{"old":\n{"next":true}\n`。这只是一次实测竞态，不承诺
  任意路径替换或并发 appender 的原子处理。
- **Writer 清理，故障注入：**async 与 sync 的 `fstat` `EIO` 都传播错误并关闭实际
  writer descriptor；错误本身是注入的，不声称它是自然发生的内核故障。
- **打包后的 CLI，原生资源故障：**`dist/cli.js` 使用隔离的 `QWEN_HOME` 和
  `QWEN_RUNTIME_DIR`、真实 daemon 和 mock OpenAI 运行。原始 `RLIMIT_FSIZE` breach 加上 `SIGXFSZ` 后，原有的
  单条 **137 字节**残缺尾保持原样，下一条完整记录独立成行。没有访问真实模型。
- 该端到端运行通过 **11/11 断言**：parent-chain gap 为 0，daemon `/load` 与
  `/context` 均为 HTTP 200，clean recovery 无 History gap。`canContinue:false` 仅表示
  没有待继续的中断任务，并不区分恢复类型；clean 与 degraded history 都可能返回
  false。本次 clean 结论由 `kind: 'clean'`、parent-chain gap 为 0，以及没有
  `History gap:` 提示共同支撑。
- **CLI 出处更正与补充验证：**原 `final verification` 评论写出的完整 revision
  `78489a70bd5a192929db2a2b6df47fad15e723ec` 无法解析为实际提交，因此无法仅凭
  该评论确认其 11/11 与 137 字节观测属于哪个变体，也不应事后擅自选定某个父提交。
  [独立的精确 head CLI 补测](https://github.com/QwenLM/qwen-code/pull/17853#issuecomment-7017284822)
  使用 Node 22.23.4 在 `b0a07fb51cadce79d9c1711f510f6d49fec60d3d` 重建
  `dist/cli.js`，并重现了这些结果。补测使用全新的临时 `QWEN_HOME` 和
  `QWEN_RUNTIME_DIR`、真实 daemon 以及本地 mock OpenAI，没有访问真实模型。
  四个实现/测试文件与 `f8fa7c476f2244d5c6832fb2bb9a551882c425b3` 逐字节一致，
  因此这份新证据覆盖已交付的 writer，而不是把原始观测改认到某个父提交。

## 扩展 core 测试运行归因

扩展的本地 core 测试运行并非全绿：**43,415 passed、65 failed、30 skipped**，另有 1 个 Vitest RPC
timeout。这些失败按已知情形归类，并未隐藏；其中 core 对照只提供有界归因：

- **42** 个来自宿主全局 pre-push hook 拒绝临时 `/tmp` remote。
- **2** 个是宿主负载导致的时延失败。
- 余下四个 **core** 套件在独立安装的树上重跑，该树使用 PR 内部较早的 head/A/B
  control `4b2dc8a350fa7057a56c4512e0dc038802f2fce2`，复现了相同的
  **21 failed / 255 passed**。这是 PR 中间 head，不是 PR base，也不是最终 PR head
  的直接父提交。该对照只能比较中间 head 之后的修订，不能排除 PR base 与这个控制点
  之间引入的失败。

没有为了得到绿色结果而弱化或禁用测试、CI 检查。因此，扩展 core 测试运行仍只是
有界归因证据，不是全仓通过或已完整排除相对 PR base 回归的声明。

## 边界与延期工作

- Windows 原生验证与 current-head macOS 验证仍未完成。早期 macOS 在 `14893f6f10`
  的报告早于最终 writer-handle 工作，不能作为已合入实现的证据。
- #17771 正文中的 Reviewer Test Plan 是旧 head 的历史记录，仍含旧的 tail-read
  fallback 换行预期、较早的 CLI bundle `85319df31d` 和 **200 passed / 2 skipped**。
  最终行为、计数和 bundle 出处应以最终 head 的源码和证据评论为准。这个较早祖先
  bundle 的引用，与另一条 final-verification CLI 评论中无法解析的完整 revision
  不是同一项。
- 这里不承诺通用 FIFO transcript、任意路径替换或并发 append 原子性、读取侧历史
  抢救或 daemon 升级/重启行为。独立的读取侧工作由 #17756 跟踪。
- **已接受的性能取舍：**最终 head 的复验测得，健康 regular file 每次 append 增加
  一次 path `stat` 与 tail-probe open。在两次交错的 150 次 fsync-append 运行中，每次
  append 的中位耗时增加为 **0.161–0.195 ms（11.0%–13.3%，async）**和
  **0.017–0.025 ms（1.3%–1.9%，sync）**。为聚焦 correctness bugfix，接受保持
  tail inspection 与 append 路径分离；这是有界实测，不是通用性能保证。合并句柄
  不属于本次变更，也不属于 #17852 的诊断与原生平台跟踪范围。
- 后续 issue #17852 跟踪 sink 恢复后的受界限告警、128-key eviction 后的重复告警、
  错误文件上下文，以及精确 `sync`/`close` 生命周期、stale completion、FIFO 目标和
  失败 append 叠加 throwing observer 的测试见证；也跟踪 Windows 与 current-head
  macOS 原生验证。
- 两个 `R3-1` 条目并不相同。一次投递失败后，已通过同一路径的真实 debug append
  验证 sink 恢复后恰好投递一条告警。三次失败投递耗尽驻留缓存条目的三次尝试预算后，
  即使 sink 随后恢复，该条目的后续告警仍被抑制。该键被 128 项容量上限驱逐后，
  新条目可使用新的预算重新尝试告警；这里不是进程级终身抑制。预算重置/cooldown 由 #17852 延期跟踪，并未宣称修复；尤其不能在
  缺少有效 cooldown 与 failure-budget 设计时，简单地在达到上限后清零 attempt counter。

本文只记录文档关系，不声称关闭范围更大的原始 #17747 工作。

## 参考链接

- [#17771](https://github.com/QwenLM/qwen-code/pull/17771) 及其
  [squash commit](https://github.com/QwenLM/qwen-code/commit/f8fa7c476f2244d5c6832fb2bb9a551882c425b3)。
- 证据评论：
  [最终验证](https://github.com/QwenLM/qwen-code/pull/17771#issuecomment-7007985759)、
  [原生与端到端证据](https://github.com/QwenLM/qwen-code/pull/17771#issuecomment-7008079523)、
  [收尾与归因](https://github.com/QwenLM/qwen-code/pull/17771#issuecomment-7009882478)、
  [R3-1 最终 head 对照复验](https://github.com/QwenLM/qwen-code/pull/17771#issuecomment-7011877438)、
  [精确 head 的 CLI 补充验证](https://github.com/QwenLM/qwen-code/pull/17853#issuecomment-7017284822)。
- 延期工作：[#17852](https://github.com/QwenLM/qwen-code/issues/17852)。
- 独立读取侧工作：[#17756](https://github.com/QwenLM/qwen-code/issues/17756)。
