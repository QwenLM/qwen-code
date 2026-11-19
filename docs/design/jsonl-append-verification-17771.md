# Legacy JSONL append isolation: verification after #17771

[English](./jsonl-append-verification-17771.md) | [简体中文](./jsonl-append-verification-17771.zh-CN.md)

**Status: Merged.** This is a post-merge verification ledger, not another append architecture proposal. Results below record #17771 verification; this documentation-only change does not rerun them.

## Status and provenance

- Pull request: #17771.
- Squash commit: `f8fa7c476f2244d5c6832fb2bb9a551882c425b3`.
- Compared PR head: `78489a70bda7e0d85f203c762aaa67d28b790410`.
- Each of the four changed files was compared byte-for-byte between that PR head
  and the squash commit; all four matched:

```text
packages/core/src/utils/jsonl-utils.ts
packages/core/src/utils/jsonl-utils.test.ts
packages/core/src/utils/debugLogger.ts
packages/core/src/utils/debugLogger.test.ts
```

- The measured SHA-256 of `packages/core/src/utils/jsonl-utils.ts` was
  `9ea6a9debcb58352dec0e0b0c94c3ee533b9189d2354bbf979ac921ff2922754`.
- PR-head checks were **28 passed, 34 skipped, 0 failed, 0 cancelled, 0 pending**.
  Skipped checks are not evidence of additional platform or feature coverage.

## Delivered behavior

The current source, rather than an earlier review intermediate, establishes this scope:

- `writeLine` and `writeLineSync` isolate an interrupted, unterminated tail from the next complete JSON record by adding the required record separator.
- Existing torn bytes remain in place. The operation appends; it does not parse, repair, reserialize, or rewrite prior history. Ordinary regular-file bytes are otherwise unchanged.
- If a regular file's tail cannot be inspected, a conservative `\n` is used only
  for `EACCES`, `EPERM`, `EAGAIN`, `ERR_ACCESS_DENIED` with
  `permission === 'FileSystemRead'`, or `EBUSY` on `win32`. `ENOENT` instead
  reopens an append handle and checks it. Other errors, including `EIO` and a
  non-read permission denial, propagate without that fallback append.
- A non-regular path does not acquire a temporary read-only tail-probe reader,
  which could consume external payload. The implementation opens the real `a`
  writer, validates the opened handle's type, and appends through that writer.
- The lifecycle depends on how the path was inspected. An existing readable
  regular file uses a tail probe that is closed after inspection; the real
  append then uses the pathname with `flush: true`. Its `openAppender` is
  `undefined`, so the optional `openAppender?.sync()` and
  `openAppender?.close()` calls do not execute. The allowlisted tail-read
  fallbacks likewise append by pathname and do not acquire a writer.
- Only an append handle actually opened for `ENOENT` or a non-regular path,
  and validated by `FileHandle.stat`/`fstat`, stays open for the real append.
  Async then explicitly calls `sync()` and closes that handle; sync appends
  through its validated descriptor with `flush: true` and closes that
  descriptor. Append, synchronization, and close failures are not converted
  into success.
- Debug warning delivery is reported only by the actual debug `fs.appendFile`
  outcome, not by a prerequisite directory operation. A throwing delivery
  observer is handled separately and is not a filesystem write failure.

This is not a claim of universal behavior across platforms or special files, generic FIFO transcript support, or a general interprocess locking protocol.

## Focused verification

The recorded passing gates were exactly:

```bash
(cd packages/core && npx vitest run src/utils/jsonl-utils.test.ts src/utils/debugLogger.test.ts)
npm run build
npm run typecheck
npm run bundle
```

The subshell keeps the focused Vitest invocation inside `packages/core` while
leaving the repository root as the working directory for the three root-level
commands.

- Focused result: **150/150 tests**, comprising **107** in `jsonl-utils.test.ts`
  and **43** in `debugLogger.test.ts`.
- The real root build, complete root typecheck, and CLI bundle each exited `0`.
- These are the verified gates; they do not mean the whole repository test run
  was green.

A negative mutation also mattered: removing the `previous.pending` guard made the async and sync pending-delivery deduplication cases fail. Restoring the guard returned the focused set to 150/150.
This is mutation evidence, not merely a claim that the unmodified tests passed.

## Native and injected-fault evidence

Native measurements used Linux with Node `22.23.4`. Fault injection is identified separately so it is not presented as a native operating-system error.

- **FIFO, native:** all four appender/native scenarios preserved external payload,
  created no temporary tail-probe reader, and retained native `fsync` error
  semantics. This does not establish general FIFO transcript semantics.
- **Lease, native:** with real Linux `F_SETLEASE`/`F_WRLCK`, the old appender hit
  `EAGAIN` and did not append. The current appender preserved the next complete
  record, while the native control retained its expected behavior.
- **Type replacement, native timing:** after `ptrace` observed a successful
  `stat`, replacing the directory with a torn regular file produced exactly
  `{"old":\n{"next":true}\n`. This is one measured race, not a promise of atomic
  handling for arbitrary path replacement or concurrent appenders.
- **Writer cleanup, injected fault:** async and sync `fstat` failures with `EIO`
  propagated the error and closed the actual writer descriptor; the error itself
  was injected, not asserted as a naturally occurring kernel failure.
- **Bundled CLI, native resource fault:** `dist/cli.js` ran with an isolated
  `.qwen_home`, a real daemon, and mock OpenAI. A raw `RLIMIT_FSIZE` breach plus
  `SIGXFSZ` left the original single **137-byte** torn tail intact and put the
  next complete record on its own line. No real-model access occurred.
- That end-to-end run passed **11/11 assertions**: zero parent-chain gaps, daemon
  `/load` and `/context` both HTTP 200, and clean recovery with no History gap.
  `canContinue:false` meant no interrupted task was waiting to continue; it did
  not mean degraded history.

## Whole-run attribution

The broad run was not green: **43,415 passed, 65 failed, 30 skipped**, plus one
Vitest RPC timeout. Its failures were attributed rather than hidden:

- **42** came from the host-global pre-push hook rejecting temporary `/tmp`
  remotes.
- **2** were host-load latency failures.
- The remaining four **core** suites were rerun on an independently installed
  tree at the earlier PR head/A/B control
  `4b2dc8a350fa7057a56c4512e0dc038802f2fce2`. They reproduced the same
  **21 failed / 255 passed**. This specified control is not the documentation
  working tree's direct parent (`HEAD^`).

No test or CI check was weakened or disabled to obtain a green result. The broad
run therefore remains attribution evidence, not a whole-repository pass claim.

## Limits and deferred work

- Native Windows and current-head macOS verification remain outstanding. The
  earlier macOS report at `14893f6f10` predates the final writer-handle work and
  is not evidence for the merged implementation.
- No general FIFO transcript guarantee, arbitrary path-replacement or concurrent
  append atomicity, read-side history salvage, or daemon upgrade/restart behavior
  is promised here. Independent read-side work is tracked in #17756.
- Follow-up issue #17852 tracks bounded diagnostics after sink recovery, duplicate
  warnings after 128-key eviction, error file context, and precise test witnesses
  for `sync`/`close` lifecycle, stale completion, FIFO targets, and failed append
  combined with a throwing observer. It also tracks native Windows and
  current-head macOS validation.
- The two `R3-1` entries are distinct. After one failed delivery, sink recovery
  was verified through a real debug append at the same path to deliver exactly
  one warning. After three failed deliveries exhaust the lifetime cap, later
  sink recovery leaves subsequent warnings suppressed by that cap. Budget
  reset/cooldown is
  deferred to #17852, not claimed as fixed; the attempt counter must not simply
  be cleared after the cap without a valid cooldown and failure-budget design.

This ledger records a documentation relationship only; it makes no claim to close
the broader original #17747 work.

## References

- [#17771](https://github.com/QwenLM/qwen-code/pull/17771) and its
  [squash commit](https://github.com/QwenLM/qwen-code/commit/f8fa7c476f2244d5c6832fb2bb9a551882c425b3).
- Evidence comments:
  [final verification](https://github.com/QwenLM/qwen-code/pull/17771#issuecomment-7007985759),
  [native and end-to-end evidence](https://github.com/QwenLM/qwen-code/pull/17771#issuecomment-7008079523),
  [closeout and attribution](https://github.com/QwenLM/qwen-code/pull/17771#issuecomment-7009882478),
  [final-head R3-1 re-evaluation](https://github.com/QwenLM/qwen-code/pull/17771#issuecomment-7011877438).
- Deferred work: [#17852](https://github.com/QwenLM/qwen-code/issues/17852).
- Independent read-side work: [#17756](https://github.com/QwenLM/qwen-code/issues/17756).
