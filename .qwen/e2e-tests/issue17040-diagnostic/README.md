# Issue 17040 portable diagnostic

Run `run.mjs` with Node 22.23.4 and the released Qwen Code 0.27.2 `cli.js`. It creates a fresh daemon/session, uses a local mock model in `auto` approval mode, and downloads 831741 bytes over about 45 seconds through an HTTPS CONNECT proxy. All network endpoints are local; the HTTPS hostname is handled by the local proxy and a temporary test certificate. The model credential is the synthetic string `sk-mock`.

The output includes isolated configuration/runtime files, a test certificate/key, `summary.json`, and bounded protocol metadata in `trace/<pid>.jsonl`. Use a new output directory for every run. The runner removes a previous `workspace/catalog.json` before starting and requires a new completed download, successful shell result with exit code 0 and expected curl output, exact file size, normal `end_turn`, and responsive stats. A generic tool result or `turn_complete` alone cannot pass.

## Windows / PowerShell

Use Node 22.23.4 (`node --version`). Install the release into a temporary directory; do not replace an existing global installation:

Set `QWEN17040_FIRST_PROMPT_DELAY_MS=12000` for the phase comparison; the default sends the first prompt immediately. This changes only the test's wait before sending a prompt, not channel liveness or shell timeouts. The outer harness waits up to 150 seconds after admission so cold startup plus the slow download is not cut off by the fixture.

Set `QWEN17040_DISABLE_PRELOAD=1` for the control with no diagnostic hooks loaded into either product process. The Windows matrix includes this control at the 12000ms delay to check for observer-induced stalls.

Dispatch the temporary workflow with `source_sha=<exact 40-character commit>` to build that source with its frozen dependencies on Windows, run AUTO permission regressions, and verify its actual bundle in three fresh sessions: immediate/probe on, delayed/probe off, and delayed/probe on. Omitting the input runs the released baseline matrix instead. The candidate source and diagnostic harness use separate checkouts; the product PR does not include this workflow or harness.

```powershell
$release = Join-Path $env:TEMP 'qwen17040-release'
npm install --prefix $release --no-audit --no-fund '@qwen-code/qwen-code@0.27.2'
$cli = Join-Path $release 'node_modules\@qwen-code\qwen-code\cli.js'
$out = Join-Path $env:TEMP ('qwen17040-run-' + [guid]::NewGuid().ToString('N'))
node C:\path\to\diagnostic\run.mjs $cli $out
Get-Content (Join-Path $out 'summary.json')
```

OpenSSL must be available. The runner automatically checks the standard Git for Windows location (`C:\Program Files\Git\usr\bin\openssl.exe`) before trying `openssl` on PATH. If needed, set `$env:QWEN17040_OPENSSL` to the executable path. Keep `run.mjs` and `wire-preload.cjs` in the same directory.

After the run, Windows cleanup uses `taskkill.exe /PID <this test's live daemon PID> /T /F`, with a ten-second deadline. It targets only the process tree created by the test. An already exited daemon is reported separately; descendant cleanup is then unverified.

## macOS invocation used for validation

```sh
/private/tmp/qwen-17040-npm-cache/_npx/361c55be1121897e/node_modules/node/bin/node \
  /private/tmp/qwen-17040-diagnostic/run.mjs \
  /private/tmp/qwen-17040-release/package/cli.js \
  /private/tmp/qwen-17040-diagnostic/mac-final
```

The Node interpreter running the harness also runs the daemon and ACP child. The temporary release's native dependencies must resolve normally; the macOS validation used the existing `@lydell/node-pty` 1.2.0-beta.10 installation through a temporary `node_modules` symlink.

## Reading the wire capture

The preload records four observation points without adding an input consumer:

| Point | Meaning |
| --- | --- |
| `daemon_write` | The daemon calls its ACP child's stdin `write()` |
| `child_receive` | The ACP child's stdin emits incoming bytes |
| `child_write` | The ACP child calls stdout `write()` |
| `daemon_receive` | The daemon receives bytes from the ACP child's stdout |

Match request/response `idHash` values across the four points. A ping request's method is `qwen/status/channel/ping`; stats requests use `qwen/status/session/stats`. Responses share the ID hash and have `kind: response`. Compare `time`, monotonic `ns`, and `startedNs` to see which boundary stopped advancing.

The ACP child's metadata also records PTY loading and spawn outcomes. A `pty_spawn_return` with `backend: "@lydell/node-pty"`, `useConptyDll: true`, and a numeric `childPid` proves that invocation returned a PTY with the production Windows backend option. `pty_load_failed` / `pty_spawn_failed` followed by `shell_pipe_spawn_return` shows a native failure followed by a plain shell process. A `shell_pipe_spawn_return` alone confirms a plain shell process but does not establish why PTY execution was skipped. Match these events to the single test command's timing; no command arguments or environment values are recorded. These observations use the same bounded log and remain disabled in Worker threads. Passing `useConptyDll: true` on macOS is only an observer sanity check; the option is inert there and does not test ConPTY.

`write_call` and `write_return` include queue size, drain state, and the return boolean. `drain`, `error`, and `close` events are observed through the existing emitter; the preload neither adds event listeners nor supplies extra write callbacks. A `write_callback` is recorded only if the caller already supplied one. Calling `write()` or returning `true` does not prove delivery to the other process or completion at the OS layer.

The ACP-only CPU profiler samples every 10ms and stops after the first event-loop delay over five seconds, or after 60 seconds. It persists only the top 25 aggregate stacks with function names, allowed code-file basenames, line/column numbers, and sample durations. It never saves the full profile or script sources. Slow synchronous filesystem calls over 500ms record duration and the same restricted stack metadata, without paths or arguments. Diagnostic logging frames remain identifiable in the aggregate so its own I/O cannot be mistaken for product work. PTY module-load start/end events separate loading from actual native spawn.

Capture keeps at most 64 KiB of a frame in memory and writes at most 2 MiB of JSONL per process. It persists only method names, hashed IDs, byte counts, process identifiers, timing, stream state, and the restricted call-site metadata described above. It does not persist request parameters, results, prompts, tool arguments, credentials, or full skill bodies. Oversized-frame metadata is extracted only from the leading JSON-RPC envelope, when possible. Worker threads return immediately from the preload; node-pty workers are not patched. The daemon's target ACP launch gets an explicit `--require` so the child-side observations do not depend on inherited preload behavior.

`PASS` means this controlled run was healthy. `FAIL` requires inspecting `summary.json` and the wire metadata; it does not automatically prove the reporter's original root cause. Windows, its bundled ConPTY backend, the reporter's proxy, and real-model behavior remain unverified until this diagnostic is run in those environments. Instrumentation itself can change timing.
