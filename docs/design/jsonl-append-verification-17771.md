# Legacy JSONL append isolation: verification after #17771

[English](./jsonl-append-verification-17771.md) | [简体中文](./jsonl-append-verification-17771.zh-CN.md)

**Status: Merged.** This is a post-merge verification ledger, not another append architecture proposal. Except for the explicitly identified CLI provenance supplement below, the results below record #17771 verification rather than a rerun by this documentation-only change.

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
- The retained historical snapshot has 62 checks, with its latest included
  completion at `2026-11-19T12:54:21Z`. The closeout comment published at
  `2026-11-19T13:02:01Z` recorded **28 passed, 34 skipped, 0 failed, 0 cancelled,
  0 pending** from that snapshot. Later automation is outside this snapshot;
  these are not recomputed current rollup totals. Skipped checks are not
  evidence of additional platform or feature coverage.

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
  fallbacks likewise append by pathname without retaining an explicit append handle.
- Only an append handle actually opened for `ENOENT` or a non-regular path,
  and validated by `FileHandle.stat`/`fstat`, stays open for the real append.
  Async then explicitly calls `sync()` and closes that handle; sync appends
  through its validated descriptor with `flush: true` and closes that
  descriptor. Append, synchronization, and close failures are not converted
  into success.
- With no active debug session or disabled file output, `warnWithDelivery`
  reports `delivered=false` without attempting `fs.appendFile`. Otherwise,
  delivery follows the actual debug `fs.appendFile` outcome, not a prerequisite
  directory operation. A throwing delivery observer is handled separately and
  is not a filesystem write failure.

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
- **Bundled CLI, native resource fault:** `dist/cli.js` ran with isolated
  `QWEN_HOME` and `QWEN_RUNTIME_DIR` values, a real daemon, and mock OpenAI. A raw `RLIMIT_FSIZE` breach plus
  `SIGXFSZ` left the original single **137-byte** torn tail intact and put the
  next complete record on its own line. No real-model access occurred.
- That end-to-end run passed **11/11 assertions**: zero parent-chain gaps, daemon
  `/load` and `/context` both HTTP 200, and clean recovery with no History gap.
  `canContinue:false` only indicated that no interrupted task was waiting to
  continue; it did not distinguish the recovery kind. Both clean and degraded
  history can return false. The clean result was established by `kind: 'clean'`,
  zero parent-chain gaps, and no `History gap:` notice.
- **CLI provenance correction and supplement:** the cited original comment names
  the malformed full revision `78489a70bd5a192929db2a2b6df47fad15e723ec`. Its
  11/11 and 137-byte observations therefore lack a resolvable tested revision in
  that publication, rather than representing a test whose ancestor we can choose
  afterwards. The [independent exact-head CLI supplement](https://github.com/QwenLM/qwen-code/pull/17853#issuecomment-7017284822)
  rebuilt `dist/cli.js` at `b0a07fb51cadce79d9c1711f510f6d49fec60d3d` using Node
  22.23.4 and reproduced those outcomes. It used fresh temporary `QWEN_HOME` and
  `QWEN_RUNTIME_DIR` values, a real daemon, and only a local mock OpenAI. The
  four implementation/test files match `f8fa7c476f2244d5c6832fb2bb9a551882c425b3`
  byte-for-byte, so this new evidence applies to the delivered writer without
  reassigning the original observation to a parent revision.

## Expanded core sweep attribution

The expanded local core sweep was not green: **43,415 passed, 65 failed, 30 skipped**, plus one
Vitest RPC timeout. Its failures were classified rather than hidden:

- **42** came from the host-global pre-push hook rejecting temporary `/tmp`
  remotes.
- **2** were host-load latency failures.
- The remaining four **core** suites were rerun on an independently installed
  tree at the intermediate PR head/A/B control
  `4b2dc8a350fa7057a56c4512e0dc038802f2fce2`. They reproduced the same
  **21 failed / 255 passed**. This is a within-PR head, not the PR base or the
  final PR head's direct parent. The comparison therefore covers revisions after
  this intermediate head; it does not exclude failures introduced between the
  PR base and this control.

No test or CI check was weakened or disabled to obtain a green result. The expanded
core sweep therefore remains bounded attribution evidence, not a whole-repository
pass or a complete PR-base regression exclusion.

## Limits and deferred work

- Native Windows and current-head macOS verification remain outstanding. The
  earlier macOS report at `14893f6f10` predates the final writer-handle work and
  is not evidence for the merged implementation.
- The Reviewer Test Plan in #17771's body is historical. It retains the older
  probe-fallback newline expectation, the older bundle `85319df31d`, and an old
  **200 passed / 2 skipped** count. Use the final-head source and evidence
  comments for the final behavior, counts, and bundle provenance. This older
  ancestor-bundle citation is distinct from the malformed full revision in the
  separate final-verification CLI report.
- No general FIFO transcript guarantee, arbitrary path-replacement or concurrent
  append atomicity, read-side history salvage, or daemon upgrade/restart behavior
  is promised here. Independent read-side work is tracked in #17756.
- **Accepted performance trade-off:** the final-head re-evaluation measured an
  additional path `stat` and tail-probe open per healthy regular-file append.
  In two interleaved 150 fsync-append rounds, per-append median increases were
  **0.161–0.195 ms (11.0%–13.3%) async** and **0.017–0.025 ms (1.3%–1.9%) sync**.
  Keeping tail inspection and append paths separate was accepted for the focused
  correctness bugfix; this is one bounded measurement, not a universal guarantee.
  Handle consolidation is outside its scope and #17852's diagnostic/native topics.
- Follow-up issue #17852 tracks bounded diagnostics after sink recovery, duplicate
  warnings after 128-key eviction, error file context, and precise test witnesses
  for `sync`/`close` lifecycle, stale completion, FIFO targets, and failed append
  combined with a throwing observer. It also tracks native Windows and
  current-head macOS validation.
- The two `R3-1` entries are distinct. After one failed delivery, sink recovery
  was verified through a real debug append at the same path to deliver exactly
  one warning. After three failed deliveries exhaust a cached diagnostic
  entry's three-attempt budget, later sink recovery leaves that entry's warnings
  suppressed while it remains cached. Eviction under the 128-key bound can admit
  a fresh entry with a new budget, so this is not a process-lifetime suppression
  for that key. Budget
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
  [final-head R3-1 re-evaluation](https://github.com/QwenLM/qwen-code/pull/17771#issuecomment-7011877438),
  [supplemental exact-head CLI verification](https://github.com/QwenLM/qwen-code/pull/17853#issuecomment-7017284822).
- Deferred work: [#17852](https://github.com/QwenLM/qwen-code/issues/17852).
- Independent read-side work: [#17756](https://github.com/QwenLM/qwen-code/issues/17756).
