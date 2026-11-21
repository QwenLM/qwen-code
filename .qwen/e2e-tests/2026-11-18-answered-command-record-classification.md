# Answered command: invalid reply versus invalid persisted record

Issue: [#14419](https://github.com/QwenLM/qwen-code/issues/14419)

## Scenario and expected behavior

Send an `answered` operation to a hosted session through
`POST /session/<sessionId>/messages/operations`. A valid reply referring to a
missing or invalid persisted command is a record conflict, not malformed input.
It must return 409 `session_command_record`. An invalid reply document must
return 400 `invalid_command_operation` before any command write.

Keep the existing behavior for other paths: 409 for command-state conflicts,
503 for store, transport, writes-stopped, unsettled-append and journal-fenced
failures, and 202 for an accepted answer or identical replay. An identical replay
must not add another resource or journal revision.

## Baseline reproduction

The first global CLI setup attempt, `qwen --version`, exited 127 because `qwen`
was unavailable. The independent test engineer therefore used the documented
test-script fallback, with real HTTP requests, command parsing, a local disk
journal and resources. On `61476010ca7f46140eaa39c77952bd1b9109a587`, the missing
and invalid persisted-record cases returned 400 instead of 409; the other 16
controls passed. See [the baseline run](https://github.com/GoldArowana/qwen-code/actions/runs/44239448334).

The invalid-record case supplies a corrupt returned record to the real parser.
The HTTP-store adapter and broker are local fixtures; injected storage failures
do not establish live remote-store or broker behavior.

## Built CLI verification plan

1. Use the pinned frozen dependency installation, then `npm run build` and
   `npm run bundle`. Run the resulting `node dist/cli.js`, not a global binary.
2. Use `HostedHarnessProcess` from
   `integration-tests/helpers/hosted-harness-process.ts` and
   `startHostedSessionStore` from
   `integration-tests/helpers/hosted-session-store.ts`. Bind fixtures to
   ephemeral loopback ports and a fresh temporary session directory.
3. Supply the broker warm, capabilities, active-holds, release and release-mount
   responses required by the current hosted-workspace profile. Reject unexpected
   broker requests. Point the model endpoint at a local server that rejects and
   counts every request; this scenario must make zero model requests.
4. Create a thread-scoped session with `POST /session`, the
   `hosted-workspace-shell/1` profile and the local HTTP-store fixture. Use the
   returned client identity for subsequent requests.
5. Send a fresh operation ID, `kind: "answered"`, a nonexistent command ID and
   `reply: { "outcome": "answered", "text": "valid reply" }`. Assert both
   HTTP 409 and `code: "session_command_record"`.
6. Send the same kind of operation with `reply: {}`. Assert HTTP 400 and
   `code: "invalid_command_operation"`.
7. Compare journal events before and after these refusals; neither request may
   append an event. Detach the session and assert 204. Check store/broker error
   lists, the zero model-request count and fixture/process cleanup.

Run the committed HTTP regression and adjacent command-funnel suites from the
CLI package as well:

```bash
cd packages/cli
npx --no-install vitest run src/serve/hosted-harness-command-operations.test.ts src/serve/hosted-session-command-session.test.ts
```

Those suites cover the malformed-input, invalid-record, storage-failure,
state-conflict, refusal, success and replay controls beyond the narrower built
CLI scenario.

## Evidence and limits

[Run 44242328634](https://github.com/GoldArowana/qwen-code/actions/runs/44242328634)
targets source `bd45cd4007a5c545c344fb3a36b3e1a073907eca`, tree
`3ca90b00bc0448a55f6332047b349ab98ed48fe7`. Its validation event commit is separate
from the tested source. This plan does not certify that run's final outcome or
claim that a later documentation commit was executed by it. Preserve the actual
command exits, test results and source attribution when reporting verification.

Run the unchanged `npm run preflight` from the repository root for the final
gate, and retain failed or incomplete results. Check tracked source bytes before
and after validation. This local-fixture scenario does not validate a production
broker, worker, Java relay, Spring/MySQL deployment, live remote store or real
model/provider, and does not establish Windows or macOS coverage.
