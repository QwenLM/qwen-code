# Scheduled-task gate

## Baseline

On `main` a scheduled task has no gate: `cron_create` accepts `cron`,
`prompt`, `recurring`, `durable` and `sessionMode`, and every fire is a model
turn. Watching a pull request with `/loop 2m …` on a scripted
OpenAI-compatible mock (`OPENAI_BASE_URL` at a local server that logs every
request) shows one model request per fire, each answered with "nothing
changed", and the TUI prints a `Cron:` line for each. In a `qwen serve`
daemon with `tools.approvalMode: "auto"` and an isolated `HOME`, a durable
task created from the Web Shell form behaves the same: one request per fire
in the bound session's transcript.

## Manual check

Interactive TUI, built bundle (`node dist/cli.js`), the mock model above, a
gate script `probe.sh` in the workspace that prints `event: comment` only when
a file `events` exists and is non-empty, then truncates it, and exits 0.

1. Ask: "every minute, run `./probe.sh` as a gate and, when it prints
   something, summarize the events". Verify `cron_create` is called with
   `gate: "./probe.sh"` and the confirmation dialog shows the command as an
   exec confirmation with a `Monitor(./probe.sh)` rule; approve once.
2. Leave `events` absent for three minutes. Verify the mock receives no
   request, the TUI prints no `Cron:` line, and `cron_list` shows the gate with
   `quiet ×3`.
3. Write `event: comment` into `events`. Verify that within one slot the TUI
   prints one `Cron:` line, the mock receives exactly one request whose user
   text starts with the task prompt and contains a `<gate-output>` block with
   `event: comment`, and `cron_list` shows `last delivered` with the time.
4. Make `probe.sh` exit 1 with `boom` on stderr. Verify one request arrives
   whose text says the gate failed, names exit code 1 and shows `boom`, and
   that the next two slots send nothing while `cron_list` counts
   `2 failures`. Restore the script; verify the next slot is quiet again.
5. Switch the composer to `!` mode and leave it there across a delivering
   slot. Verify the fire is delivered to the model, not executed as a shell
   command.
6. Create the same task with `durable: true`, quit, restart the TUI in the
   same workspace. Verify `cron_list` shows the gate and its status, and that
   a delivering slot wakes the session. Open
   `~/.qwen/tmp/<project-hash>/scheduled_tasks.json` and verify the task
   carries `gate`, `gateStatus` and a `condition` equal to the gate.
7. Run an older build (`main`) in the same workspace. Verify it warns that
   the task carries a legacy precondition and will not fire, and that the mock
   receives nothing.
8. Delete the task while `probe.sh` sleeps 20 s with an event pending.
   Verify nothing is delivered after the delete.

Daemon (PR 1b): `node dist/cli.js serve --port <port> --token <token>
--workspace <ws>` with the same isolated `HOME` and mock.

9. In Web Shell, open "New scheduled task"; verify the "Gate command" field is
   present (the daemon reports `scheduledTaskGate`). Create a durable task
   with the gate; verify the task card shows the gate line.
10. Repeat steps 2–4 through the bound session's transcript: quiet slots add
    nothing to it, a delivering slot adds one cron user record and one model
    request, a failing gate adds one notice.
11. Click "Run now" with `events` absent. Verify the session receives a
    manual-run prompt that asks the model to run the gate, the model runs
    `./probe.sh` as a shell tool call, and reports that it printed nothing.
12. Restart the daemon. Verify the task reloads with its gate and status, and
    that a delivering slot still wakes the bound session.

## Automated coverage

`cronScheduler.test.ts` pins the four outcomes and the composed prompt, the
in-flight skip, delete and disable during a gate run, `stop()` aborting a
gate, missed carriers never gated, catch-up, final and `forceFireJob` gated,
and `gateStatus` plus the run ring for durable tasks. `cronTasksFile.test.ts`
pins the field round trip, the `condition` fuse and `taskHasLegacyCondition`.
`cron-create.test.ts` pins the Monitor-style default permission, the exec
confirmation and its rules, the classifier input, and that a bare
`cron_create` rule does not cover a gate; `cron-list.test.ts` pins the status
line. The gate runner tests pin cwd, environment, timeout, output caps,
sanitization and the per-mode permission evaluation. `use-llm-stream.test.tsx`
pins that cron fires never route to shell mode; `Session.test.ts` and
`nonInteractiveCli.test.ts` pin pass-through of composed prompts. PR 1b adds
the REST, capability and Web Shell tests listed in the design.
