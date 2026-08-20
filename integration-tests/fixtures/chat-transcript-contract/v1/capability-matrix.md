# Chat transcript contract prevalidation matrix

MR1 freezes evidence for the current paths. A green test run means that the
evidence is reproducible; it does not turn a failed migration gate into a pass.

| Capability                      | Current path under test                             | Evidence                                               | MR1 gate                     | Follow-up owner         |
| ------------------------------- | --------------------------------------------------- | ------------------------------------------------------ | ---------------------------- | ----------------------- |
| ChatRecord semantic projection  | persisted records → SDK transcript projector        | representative record fixture and semantic snapshot    | PASS                         | existing SDK path       |
| Web Shell runtime compatibility | SDK blocks → default interactive/read-only adapter  | roles plus unchanged `rawInput`/`rawOutput` assertions | PASS                         | existing Web Shell path |
| `write_file` Turn Output        | raw tool input → complete file diff                 | focused Web Shell regression                           | PASS                         | existing Web Shell path |
| direct-daemon identity          | daemon envelopes → current SDK reducer              | full history versus partial-prepend probe              | **FAIL — migration blocked** | MR2                     |
| ACP identity                    | ACP session updates → current SDK reducer           | full history versus partial-prepend probe              | **FAIL — migration blocked** | MR2                     |
| Export document contract        | frozen V1 schema and security allowlist             | schema and hash assertions only                        | DEFERRED                     | MR2                     |
| document-mode rendering         | sanitized export document → Web Shell document mode | no production consumer or browser probe in MR1         | DEFERRED                     | MR2                     |
| VS Code migration               | selected transport → shared ChatPanel contract      | depends on a passing identity gate                     | BLOCKED                      | MR2                     |
| Desktop reuse                   | packaged Web Shell artifact                         | no installed-artifact behavior probe in MR1            | DEFERRED                     | existing Desktop path   |

No VS Code transport is selected in MR1. Both current candidate paths use
reducer-ordinal block IDs, and the ACP text updates also lack a native stable
source identity. MR2 must resolve and verify those facts before selecting a
transport or wiring a production consumer.
