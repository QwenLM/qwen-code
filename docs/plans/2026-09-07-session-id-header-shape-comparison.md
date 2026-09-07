# Where should a per-conversation session header be configured?

Two shapes for the same user need (#10995): a gateway that requires a stable
per-conversation identifier, e.g. OpenCode Go rejecting requests without
`x-opencode-session`.

- **Shape A** — `outboundCorrelation.sessionIdHeader: { enabled, headerName, trustedHosts }`, a
  new global setting with its own host allowlist. This is what PR #11282 implements.
- **Shape B** — a `${session_id}` placeholder in the existing per-provider
  `modelProviders[].generationConfig.customHeaders`, plus one global consent
  switch. This branch implements it, for comparison.

Nothing here argues against the feature. Both shapes ship it. The question is
only where the configuration lives.

## The deciding argument: Shape A cannot express two gateways

`sessionIdHeader.headerName` is a single global string, and `trustedHosts` is a
list of hosts that all receive **that one** header name. So:

| Scenario                                                          | Shape A                                   | Shape B                             |
| ----------------------------------------------------------------- | ----------------------------------------- | ----------------------------------- |
| Provider X needs `x-opencode-session`                             | ✅                                        | ✅                                  |
| …and provider Y needs `x-session-id` at the same time             | ❌ **inexpressible**                      | ✅                                  |
| Provider Z must not send it                                       | via `trustedHosts` omission               | automatic — no header on that entry |
| Two model entries on the _same host_, only one behind the gateway | ❌ host allowlist cannot distinguish them | ✅ per-entry                        |

The second row is the one that matters. It is not a style preference: a user
with two gateways has to pick one header name and let the other provider receive
the wrong one.

## `trustedHosts` re-encodes information the config already has

You write the endpoint once in `modelProviders[].baseUrl`. Shape A asks you to
write the same host again in `trustedHosts`, and then compares the two copies you
wrote. That duplication exists only because the setting is global: a global
setting has no scope of its own, so it has to build one, and the only material
available is the `baseUrl` you already supplied.

The one advantage of a global setting — "configure it once instead of per
provider" — is exactly the case where the session ID reaches hosts you did not
think about, which is what the allowlist then exists to prevent. It creates the
problem it spends most of its code solving. In this branch, roughly 90 lines of
host normalization, punycode conversion, wildcard/scheme/port rejection and
allowlist validation are simply absent, because the scoping is inherited.

## What Shape B keeps from the reviewer's objection

LaZzyMan's round-8 objection to PR #4390 — recorded in
`docs/design/telemetry-outbound-propagation-design.md` §12.1 — was that
`telemetry.*` implies "recipient is your own OTLP collector", while these headers
go to a third-party LLM provider, and the two deserve different consent decisions.
That argument is correct and Shape B keeps it: `outboundCorrelation.allowDynamicHeaderValues`
is a consent switch under the same namespace, default off.

What Shape B does _not_ put in the global namespace is scoping and naming, which
the provider entry already answers.

The switch earns its place for a second reason: `customHeaders` can arrive from a
provider preset (`packages/core/src/providers/presets/*.ts` ship them) or an
extension, and provenance is lost once presets and user settings are merged. The
gate is what separates "I typed this" from "something shipped this", so a preset
cannot silently promote a static header into an identity header.

## Where the `trustedHosts` allowlist actually comes from

It is not arbitrary, and it has a named origin. In his round-8 follow-up review
of PR #4390 (2026-05-25T03:24), LaZzyMan listed what the outbound-correlation
follow-up PR should cover, including:

> - **Override semantics**: same `trustedHosts` allowlist mechanism you've built
>   here **can carry over unchanged**

Two things about the context matter:

1. **It was said about the built-in, automatic header.** In R3 the mechanism
   attached the session ID to every provider; the allowlist is what removed that
   "dangerous default", narrowing it to three first-party hosts. For a header the
   client attaches _by itself_, an allowlist is the only possible source of
   scope, and it is plainly right.
2. **"Can carry over", not "must".** For a header the _user_ writes into a
   provider entry, the scope already exists — they chose the `baseUrl`. The
   allowlist was permission to reuse working code, not a derivation that the
   user-configured case needs one.

So Shape B does not contradict LaZzyMan's position. What he asked for was scope
discipline and a consent decision outside `telemetry.*`: "its own settings tree,
its own threat model, and its own user consent flow", default off. Shape B keeps
all of that in `outboundCorrelation.allowDynamicHeaderValues`. What it declines
to carry over is the allowlist, for the case where it duplicates scope rather
than creating it.

## Provenance: one argument was never engaged with

§12.2 of `docs/design/telemetry-outbound-propagation-design.md` says:

> 经过几轮内部讨论（含 yiliang 提出的 customHeader 模板替代方案，最终判定 customHeader 不能携带 runtime-dynamic 值），决定走 **方案 C**

Against the record of PR #4390 (all of it public — the discussion happened in
that PR's review thread, not off-GitHub):

| Time (UTC)      | Who        | What                                                                                                 |
| --------------- | ---------- | ---------------------------------------------------------------------------------------------------- |
| 05-22 08:52     | LaZzyMan   | CHANGES_REQUESTED, escalating from the earlier read                                                  |
| 05-22 **10:59** | yiliang114 | [The `customHeaders` comment](https://github.com/QwenLM/qwen-code/pull/4390#issuecomment-4518059628) |
| 05-22 15:11     | doudouOUC  | Replies **to @LaZzyMan**                                                                             |
| 05-25 03:24     | LaZzyMan   | "Review (round 8 follow-up)" — the text §12.1 quotes                                                 |
| 05-25 05:44     | doudouOUC  | "accepting the split" (方案 C)                                                                       |
| 05-25 13:26     | LaZzyMan   | APPROVED                                                                                             |
| 05-25           | jinye      | Commit `62ed44e1f` adds the design doc                                                               |

Note that `doudouOUC`'s GitHub display name is _jinye_: the PR author and the
design doc's author are the same person.

Findings:

- **The proposal is real**, at the timestamp above.
- **It was not a "template" proposal.** The word does not appear in it. The
  argument was that `customHeaders` is _per-provider_ — "without leaking
  identifiers indiscriminately to all third-party providers" — at "zero
  additional complexity". The scoping point is the one that turns out to decide
  the design, and it is the one the recorded rejection does not address.
- **The recorded rejection describes the code, not a constraint.**
  `buildHeaders()` does run once inside `buildClient()`, but the per-request hook
  already exists in `wrapFetchWithSessionId`, which sets headers _after_ the
  SDK's — which is what this branch uses.
- **No reply to it exists anywhere in the public record.** Searching all three
  surfaces of #4390 — issue comments, inline review comments, and formal review
  bodies — the string `customHeader` appears exactly once, in that comment.
  LaZzyMan never mentioned `customHeaders` in any of his three reviews, and his
  round-8 closing line addresses `@wenshao @doudouOUC`, so the per-provider
  argument was never in front of the reviewer whose objection shaped the outcome.

The likeliest reconstruction is ordinary: the comment landed in the middle of a
LaZzyMan↔doudouOUC argument, nobody picked it up, and three days later it was
summarized into the design doc as discussed-and-rejected. Nothing here suggests
bad faith. It matters only because #11282 → §12.7 → §12.2 is the chain that makes
Shape A look pre-decided, and the root of that chain is a conclusion no one
publicly answered.

## What this branch changes

| File                                                                                     | Change                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/src/core/outbound-dynamic-headers.ts`                                              | New. Placeholder set, per-value expansion, fail-closed drops, `Headers` rewrite, per-request subset for Gemini.                                                                                                                                                |
| `core/src/core/outbound-session-id.ts`                                                   | Fetch wrapper expands placeholders before writing the built-in header, preserving `correlation > customHeaders` precedence. Whether any placeholder exists is decided once at client construction, so providers without one cost exactly what they cost today. |
| `openaiContentGenerator/provider/{default,dashscope}.ts`, `anthropicContentGenerator.ts` | Pass the provider's `customHeaders` to the wrapper.                                                                                                                                                                                                            |
| `llm-content-generator.ts`                                                               | Re-emit the placeholder-bearing subset per request, overriding the client-level copy the SDK froze at construction.                                                                                                                                            |
| `config/config.ts`, `cli/src/config/settingsSchema.ts`                                   | `outboundCorrelation.allowDynamicHeaderValues`, default false.                                                                                                                                                                                                 |
| docs                                                                                     | `model-providers.md` (where the header goes), `settings.md` (the consent switch).                                                                                                                                                                              |

Not implemented here, deliberately: removing Shape A. If Shape B is chosen,
#11282's opt-in branch comes out and its built-in first-party allowlist stays
untouched.

## Verification status

Run locally in a sandbox worktree (workspace `node_modules` and `dist` overlaid
by symlink; four missing `exports` entries stubbed to satisfy the vitest global
setup — none of them imported by these suites):

```
✓ src/core/outbound-dynamic-headers.test.ts                     (20 tests)
✓ src/core/outbound-session-id.test.ts                          (14 tests)
✓ src/core/openaiContentGenerator/provider/default.test.ts      (38 tests)
✓ src/core/openaiContentGenerator/provider/dashscope.test.ts   (162 tests)
✓ src/core/anthropicContentGenerator/anthropicContentGenerator.test.ts (165 tests)
✓ src/core/llm-content-generator/llm-content-generator.test.ts  (22 tests)

Test Files  6 passed (6)
     Tests  421 passed (421)
```

The last four are the suites whose built-in `session_id` assertions #11282's
first commit broke; they pass here unmodified, which is the regression this
shape has to clear too. ESLint passes on every changed file.

Still **not** verified here, and CI's to confirm:

- `npm run typecheck` and a full build were not run.
- `npm run generate:settings-schema` could not run (it loads the built core
  through `dist/`, and this box cannot build it). The `settings.schema.json`
  entry was added by hand, with the description string extracted
  programmatically from `settingsSchema.ts` so the two cannot disagree.
  **CI's schema-drift check is the authority** — if it reports a diff, re-run
  the generator and commit the result.
- No test covers the four provider call sites actually forwarding
  `customHeaders` into `buildSessionAwareFetch`; that wiring is verified only by
  reading.

To reproduce on a build-capable machine:

```bash
npm run build
npm run test --workspace=@qwen-code/qwen-code-core -- src/core/outbound-dynamic-headers.test.ts
npm run generate:settings-schema && git diff --exit-code packages/vscode-ide-companion/schemas/settings.schema.json
npm run typecheck && npm run lint
```
