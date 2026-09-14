# External reasoning overrides, bounded redesign

[English](external-reasoning-overrides-v2.md) | [简体中文](external-reasoning-overrides-v2.zh-CN.md)

Status: implemented; local validation passed. Supersedes the implementation
approach in PR #11521. The new PR must stay within 3,500 changed lines, counting
additions and deletions across production code, tests, generated files and docs.

## 1. Goal and boundary

Let consumers override a model's reasoning format, supported effort tiers and
default through settings. The default must affect real requests and the UI.
Support new names and gateway aliases that reuse an existing provider protocol.
Apply reasoning changes before the next user prompt; preserve the active prompt,
including its tool continuations, retries and derived agents.

Reuse `modelProviders[].capabilities.reasoning`. Do not introduce a parallel
`generationConfig.reasoningConfig`, per-effort budget mapping, request template
language or new authentication protocol. Do not redesign the model registry,
image-model lifecycle, credential refresh, scheduling, runtime snapshot restore
or generic provider error handling. Endpoint and credential changes are outside
this feature's next-prompt guarantee; keep their existing lifecycle.

Main already exposes reasoning capabilities to model discovery and controls,
and some adapters read them. The gaps are consistent default application,
explicit format selection for aliases, and a stable reasoning view during a
prompt. Fill those gaps instead of adding a second configuration system.

## 2. Public configuration

Known model, changing only its default:

```json
{
  "id": "qwen3.8-max",
  "capabilities": {
    "reasoning": { "defaultEffort": "medium" }
  }
}
```

New model on an existing OpenAI-compatible provider:

```json
{
  "id": "company-model-v2",
  "baseUrl": "https://gateway.example.com/v1",
  "envKey": "COMPANY_MODEL_API_KEY",
  "capabilities": {
    "reasoning": {
      "profile": "openai-effort",
      "efforts": ["low", "medium", "high"],
      "defaultEffort": "medium"
    }
  }
}
```

Use existing `efforts` and `defaultEffort`; add only optional `profile`.
Accept partial declarations and resolve them before the existing strict
capability parser. Separate the partial input type from the complete resolved
`ModelReasoningCapabilities`; downstream consumers never receive partial values.
Preserve the existing complete declarations, including
`thinking`, `toggleOnly`, `canDisable` and `disableField`, without migration.
Do not add new on/off policy fields in this PR.

| Field           | Responsibility                                                                           |
| --------------- | ---------------------------------------------------------------------------------------- |
| `profile`       | Select an existing reasoning wire strategy; never select an SDK, endpoint or credential. |
| `efforts`       | Replace the supported subset of `low/medium/high/xhigh/max`.                             |
| `defaultEffort` | Supply the effort when no explicit selection or existing raw override takes precedence.  |

Omitted fields inherit capabilities from the existing provider catalog at the
selected endpoint; exact model IDs take precedence over normalized aliases.
Unknown gateway routes require an explicit declaration. Replacing `efforts` replaces
the array rather than merging it. An inherited default is clamped using the
existing helper; an explicitly supplied default must belong to the effective
set. Unknown tiered models must declare `profile`, `efforts` and `defaultEffort`;
do not invent a default or add a new model-name table. Toggle-only profiles need
no effort fields and reject them. Keep the supported canonical tier vocabulary.

Profiles are a closed set of existing formats:

| Protocol              | Profiles and existing wire shapes                                                                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI Chat           | `openai-effort`: flat effort; `openai-reasoning`: nested reasoning; `deepseek-openai`: DeepSeek thinking and reasoning-history format.                                      |
| Qwen over OpenAI Chat | `dashscope-effort`: tiered effort; `dashscope-thinking`: top-level toggle; `qwen-chat-template`: nested template toggle.                                                    |
| OpenAI Responses      | `openai-reasoning`: existing Responses reasoning format.                                                                                                                    |
| Anthropic             | `anthropic-manual`: enabled thinking and fixed/derived budget; `anthropic-adaptive`: adaptive thinking and output effort; `deepseek-anthropic`: existing compatible format. |
| Gemini/Vertex         | `gemini`: existing thinking-level mapping, limited to low/medium/high.                                                                                                      |

An explicit adaptive profile always selects adaptive thinking. A consumer that
needs manual budgets selects the manual profile. Do not add an adaptive-only
synonym. Omitted profile preserves current inference. Explicit profiles replace
reasoning-format inference, not endpoint-specific non-reasoning restrictions.
With an explicit profile, derive wire controls from it; `disableField` remains a
legacy format hint only when profile is omitted. Do not carry two competing
format selectors into adapter execution.

## 3. Resolution and request flow

One pure resolver produces the effective capability, default and wire strategy
from the exact route, its declaration and existing built-ins. UI and adapters
consume that result. Resolve against the actual selected route, not a registry
placeholder endpoint. An explicit profile eliminates hostname inference for
reasoning format. Never obtain another endpoint's declaration by model ID alone.
For an entry without `baseUrl`, preserve its existing registry selection identity
and resolve inference against the selected runtime endpoint. An explicit endpoint
override that selects a different route must resolve its own declaration.

Keep model defaults separate from user choices. Determine the effective effort
as existing explicit session/request selection, then the resolved model default.
Use the existing supported-tier reconciliation once; do not add a second
name-based clamp after an explicit capability has resolved the tier.

`generationConfig.reasoning`, `samplingParams` and `extra_body` keep their current
provider precedence and escape-hatch behavior. Profile shaping substitutes for
the existing inferred reasoning stage; it is not a final whole-body rewrite.
Apply defaults below existing raw overrides and retain request opt-out and
existing mandatory-thinking handling. Reuse each adapter's current projection
for recognized raw overrides. Where raw input prevents determining an effective
tier, use the existing unspecified/blocked control state instead of falsely
claiming the configured default was sent. Do not reconcile arbitrary conflicting
raw fields, expand their accepted shapes, or add a new override UI.

Small provider-specific changes select existing serialization and required
thinking-history preparation together. Keep tool choice, sampling, authentication,
cache behavior and non-reasoning history rules in their existing owners.
Unsupported future protocols require adapter work, not another configurable DSL.

## 4. Next-user-prompt lifecycle

Maintain one immutable reasoning-only table per admitted prompt. Each entry uses
the existing exact route identity and contains reasoning metadata only. Capture
all configured reasoning routes so a side query or subagent created after a disk
reload still sees the parent prompt's version. Reuse route identity helpers.

Settings observation prepares the latest valid reasoning table. At the existing
user-prompt admission boundary, replace the active table once. A changed table
does not replace the current generator, call `refreshAuth`, switch models, update tools or
replace a registry. Cached side-model views are invalidated on adoption; existing
views retain their captured table. Normal authentication refresh carries the current active
reasoning table forward; it cannot promote pending reasoning changes.

Adapters read the captured table, not live registry reasoning. A derived agent
inherits the captured table but resolves its own route. An unknown route uses its
own existing built-ins; it never inherits the parent's capability. Existing
model-switch flows retain their route and preference rules and resolve reasoning
from the active table. The next user prompt promotes the latest table.

Automatic retries, tool continuations and Goal/background continuations do not
promote pending reasoning. Newly created sessions use the latest configuration.
Cold model previews may read the latest validated table; an existing session's
controls display its active table and update when that session adopts the change.

Runtime resolution of invalid declarations returns no override, preserving
existing behavior even in a fresh session. Strict staging validation rejects
invalid reasoning updates, keeps the previous valid table, and reports a
model/field error through existing error channels. They must not reject unrelated
settings updates or erase healthy model rows. Validate static fields independently
from endpoint inference; no global boot failure based on placeholder URLs.

## 5. Implementation and size budget

Start from a fresh main-based branch; do not cherry-pick the old implementation.
Implement in four bounded groups: capability resolution; existing adapter hooks;
prompt reasoning snapshot propagation; controls and configuration documentation.
Use direct core-module imports in CLI production code. No unrelated cleanup.

| Group                                                 | Changed-line budget |
| ----------------------------------------------------- | ------------------: |
| Production implementation                             |               1,450 |
| Focused unit tests                                    |               1,350 |
| Local E2E harness and scenarios                       |                 270 |
| Both design languages, user docs and generated schema |                 430 |
| Review reserve                                        |                   0 |
| Total hard limit                                      |               3,500 |

Count additions plus deletions in the final PR diff against its main merge base,
including renames, generated schemas and every test/document shipped. Track
uncommitted/new files too. Do not hide implementation in ignored files or omit
necessary tests to meet the limit. Exceeding a group budget requires simplifying
within this scope; exceeding 3,500 blocks submission rather than silently growing
the limit. Merge-only upstream changes do not count, but conflict-resolution
changes that remain in the PR do.

## 6. Validation and acceptance

1. Known Qwen 3.8 Max with only default medium: controls select medium and the
   actual request sends medium; no "Use model default" menu item.
2. Unknown aliases for each listed format: declared tiers/default are used and
   final request shape matches the selected existing strategy. Cover toggle-only,
   manual/adaptive thinking, supported-tier reconciliation and explicit off.
3. No declaration: request bodies and existing controls remain unchanged. Existing
   complete capability declarations still work; raw override behavior is preserved.
4. Exact same-name endpoints and model switching: no capability leakage, model
   default is not persisted as user preference, explicit selections follow the
   existing reconciliation policy. Include Qwen, DeepSeek and Kimi switching.
5. Reload twice during a tool-using prompt: requests, retries and newly created
   child agents retain the original table; next user prompt uses the latest valid
   one. Include a later image/endpoint update to prove this mechanism does not
   introduce image/credential staging or transactions.
6. Invalid profiles, tiers, defaults and endpoint-dependent inference: preserve
   the previous reasoning configuration and healthy model discovery with a useful
   error; never send a fabricated fallback profile.

Record the installed CLI baseline, then test a local built bundle against
controlled endpoints using dummy credentials. Run package-local focused tests,
full build/typecheck, lint and actual local E2E; perform two clean diff audits.
Publish the E2E report and line-count breakdown with the new PR. Passing tests do
not authorize scope expansion. Local wire and browser validation uses controlled
endpoints; it does not establish acceptance by real provider services.
