# Model-level OpenAI API selection

[English](model-api-selection.md) | [简体中文](model-api-selection.zh-CN.md)

## Problem and scope

OpenAI Chat Completions and Responses share credential configuration, but today
Qwen Code exposes them as separate authentication choices and provider buckets.
Users must change `openai` to `openai-responses` to select the request format.

Add `wireApi: "chat-completions" | "responses"` to each OpenAI-compatible model,
beside `id`, `baseUrl`, and `envKey`. Present one OpenAI-compatible provider
choice followed by API selection. Keep internal protocol identities and recorded
session routes distinct. This is a Qwen Code feature, not a port from
another codebase. Native computer-use behavior, reasoning defaults, transport
implementations, automatic protocol detection, and automatic credential
migration are out of scope.

## Configuration contract

```json
{
  "modelProviders": {
    "openai": [
      {
        "id": "gpt-6-astra",
        "wireApi": "responses",
        "envKey": "IDEALAB_API_KEY",
        "baseUrl": "https://gateway.example.com/v1",
        "generationConfig": {
          "reasoning": { "effort": "xhigh" },
          "contextWindowSize": 272000
        }
      }
    ]
  }
}
```

| Provider protocol                                        | Model `wireApi`               | Effective internal protocol |
| -------------------------------------------------------- | ----------------------------- | --------------------------- |
| `openai`                                                 | omitted or `chat-completions` | `openai`                    |
| `openai`                                                 | `responses`                   | `openai-responses`          |
| Custom provider mapped to `openai`                       | same rules                    | same rules                  |
| Released `openai-responses` (including mapped providers) | omitted                       | `openai-responses`          |
| Released OpenAI-family declarations                      | specified                     | selected `wireApi`          |
| Other known protocol                                     | specified                     | configuration error         |

Unknown `wireApi` values are configuration errors. This field cannot make an
unknown provider id valid; existing unknown-provider warnings remain. Setup
uses one OpenAI credential namespace and writes both APIs under `openai`.
Explicit `envKey` values retain their meaning within the supported format.
`wireApi` is routing metadata and is never forwarded in request bodies.

Responses shipped in v0.23.3 before this refactor. Keep reading the released
`modelProviders.openai-responses` bucket and `providerProtocol` mappings to
`openai-responses`, including empty buckets and unused mappings. Explicit
provider mappings retain precedence over bucket names; an explicit model
`wireApi` overrides either OpenAI-family protocol. Missing `wireApi` retains
the declared protocol. Loading and hot reload never rewrite settings or add
credential references. Existing explicit references and default credential
resolution retain their published meaning. The draft field `api` is not an alias.

New setup writes `openai` plus per-model `wireApi`. Reconfiguration preserves
metadata and credential references for the exact selected route. It removes
only matching legacy entries in the writable scope, comparing effective API,
model id and exact configured URL. Buckets whose provider id contains a dot
are left untouched, because the settings adapters would write them as nested
paths; if such a stale entry still wins, the install fails before writing.
Other endpoints, APIs, models and scopes
remain intact; custom mappings are not rewritten. A higher-precedence override of the selected released declaration rejects
reconfiguration before writing; reconfigure it in its owning context without
that override. Other overrides that prevent the new configuration taking effect
cause rollback. Internal
`AuthType.USE_OPENAI_RESPONSES` continues to identify Responses transport and
recorded session routes. There is still one OpenAI provider choice.

The name `wireApi` identifies the request protocol explicitly, following the
meaning of Codex's `wire_api` while retaining this project's camelCase settings.
The field remains per-model so one provider can offer both APIs.

## Runtime and setup design

Use one shared per-model protocol resolver for registry ingestion, startup
configuration, credential lookup, setup inspection, and model editing. Preserve
the existing effective `(authType, model id, configured baseUrl)` identity.
Two entries with the same model and URL but different APIs remain distinct.
Duplicate entries for the same effective route keep the existing first-wins
policy. Provider installation must also compare effective API when merging.

When a model was explicitly selected, raw startup selection of `openai` can select an explicitly configured Responses
model when that model has no matching Chat route. An exact matching effective
route takes precedence, including the configured URL discriminator. Once
resolved, generator creation, model options, and session recording use the
effective protocol. Explicit model switches and recorded session routes remain
exact; do not add cross-protocol fallback to general registry lookup. Existing
enforced-auth policy is not broadened.

Hot reload is transactional: invalid edits leave the prior registry usable.
Changing or removing an active route's API must not combine credentials from
the new route with the old generator or silently substitute another API. Keep
the existing route-unavailable behavior and require explicit selection of the
changed route when necessary. A failed re-authentication after such an edit
is reported to the user once, with guidance to reselect the route or restart.
Restart may resolve the newly edited startup
configuration. Existing session records need no new field because their
effective auth type already distinguishes both APIs.

Ink and OpenTUI share the provider setup hook; both must present API selection
and show the exact persisted configuration in their preview, with custom
header values masked; when the planner refuses the inputs, the review step
shows the refusal instead of a preview. VS Code and Web Shell must expose the same choice. Web Shell uses a labelled review summary with masked credentials; it must
show the selected API without inventing generated settings or defaults. ACP and daemon installation inputs accept
`wireApi` and validate it before writing settings. ACP authentication labels use
one shared OpenAI key method for both runtime APIs. Model removal matches each entry's effective protocol and must not
clear the active selection when deleting its other-API sibling.

Initial authentication retries retain the resolved startup wire even after a
failed attempt. A successful explicit model selection or provider installation
ends that startup mapping, including before the first generator is created.
ACP persists User's own OpenAI wire choice independently of Workspace-derived
runtime authentication. Deletion validates each writable scope against its own
effective settings and preserves valid Workspace selections that inherit fields
from a cleared User selection. The Workspace `model` pair is decided once,
as an atomic name/baseUrl pair, and only when the workspace owns neither
field: an inherited selection that loses its route in the workspace is
tombstoned there, and a preserved one is pinned with a credential-bearing URL
replaced by an empty tombstone rather than copied into the shareable
workspace file. Both fast and full startup capture the environment
before loading workspace values. User selection validation uses that immutable
snapshot with User's own settings and home-level `.env` files, discovered from
home rather than the workspace or its ancestors. Shell and home credentials
remain valid global inputs; workspace-only values cannot preserve a stale User
selection. This snapshot is used only for deletion validation, not to change the
daemon or Workspace runtime environment. A survivor must be the first registered
route and eligible for conversation use.

Preview and submission use the same canonical view of existing models, including
released declarations without modifying the source settings. Preset
reconnection without an explicit API input preserves each saved model's API at
the exact same endpoint, including both APIs for the same model id. The shared
install builder performs this preservation for every entry point. The saved
selection determines the plan's active route, not the API of other models;
generic custom-provider setup keeps its visible API choice, prefilled from
the identified saved route. New models retain
the preset defaults. Installs with preserved API stamps retire template-version
metadata that an unstamped template cannot reproduce.

Credential rotation preserves `${...}` references by comparing each write with
the same resolved snapshot that produced its input. Legacy pruning uses its own
latest write snapshot; final runtime reads resolve the newly stored environment.
The CLI refreshes all provider buckets in the writable scope after a model write,
so duplicate mapped routes cannot retain stale headers after credential rotation.
Placeholder recovery follows the registry's first-wins ordering across provider
buckets while still rejecting ambiguous references within the winning bucket.
Explicit credential references are never migrated automatically.

`protocolOptions` controls SDK protocol selection, not whether a model may use
`wireApi`. Voice transcription currently supports Chat Completions only:
Responses voice configurations are rejected before writes, including prebuilt
models and preserved service metadata. Conversation and image models retain
both wire choices.

Implementation areas: core model types/registry/config and provider install;
CLI configuration/auth lookup and hot reload; setup views; ACP and daemon
installation contracts; SDK daemon request types; settings schema and user
documentation. No daemon route ownership or workspace-resolution rules change.

## Validation and acceptance

- Unit tests cover the configuration table, invalid inputs, mixed API entries,
  exact endpoint credentials, install merge, and transactional registry reload.
  Released provider ids and mappings remain readable without disk migration.
- Configuration tests cover initial `openai` selection resolving Responses,
  explicit route precedence, model switching, and recorded session restoration.
- Setup tests cover API selection, preview/write parity, shared credentials,
  canonical inspection, request validation, and deletion of only the intended API.
- Regressions cover failed-auth retries versus explicit selection, opposite
  User/Workspace auth choices, deletion with inherited model fields, service
  aliases shadowing conversation routes, saved preview metadata, preset
  reconnection, and voice/wire validation before persistence.
- An isolated localhost server records actual CLI endpoint paths and payloads:
  implicit Chat, explicit Chat, canonical Responses, custom-provider Responses,
  released Responses declarations, invalid API rejection before any request, and
  tool continuation for both APIs.
- Dry-run the plan against global `qwen`, then verify the built local CLI. Use
  temporary `QWEN_HOME` directories and mock keys; do not modify real settings
  or send test prompts to a remote model.
- Run build, typecheck, focused unit tests, bundle, formatting/lint checks, two
  clean self-audit passes, and independent review before declaring completion.

Acceptance requires correct request formats and preserved route identity, not
merely successful JSON parsing or a zero exit code. Detailed execution results
live in the git-ignored `.qwen/e2e-tests/pr11538-canonical-wire-api/` directory;
publish the verification report on the PR so reviewers have accessible evidence.
