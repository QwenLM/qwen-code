# Model-level OpenAI API selection

[English](model-api-selection.md) | [简体中文](model-api-selection.zh-CN.md)

## Problem and scope

OpenAI Chat Completions and Responses share credential configuration, but today
Qwen Code exposes them as separate authentication choices and provider buckets.
Users must change `openai` to `openai-responses` to select the request format.

Add `api: "chat-completions" | "responses"` to each OpenAI-compatible model,
beside `id`, `baseUrl`, and `envKey`. Present one OpenAI-compatible provider
choice followed by API selection. Preserve existing settings, internal protocol
identities, and recorded sessions. This is a Qwen Code feature, not a port from
another codebase. Native computer-use behavior, reasoning defaults, transport
implementations, automatic protocol detection, and automatic credential
migration are out of scope.

## Configuration and compatibility

```json
{
  "modelProviders": {
    "openai": [
      {
        "id": "gpt-6-astra",
        "api": "responses",
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

| Provider protocol                                | Model `api`                   | Effective internal protocol |
| ------------------------------------------------ | ----------------------------- | --------------------------- |
| `openai`                                         | omitted or `chat-completions` | `openai`                    |
| `openai`                                         | `responses`                   | `openai-responses`          |
| `openai-responses`                               | omitted or `responses`        | `openai-responses`          |
| `openai-responses`                               | `chat-completions`            | `openai`                    |
| Custom provider mapped to either OpenAI protocol | same rules                    | same rules                  |
| Other known protocol                             | specified                     | configuration error         |

Unknown API values are configuration errors. An `api` field cannot make an
unknown provider id valid; existing unknown-provider warnings remain. Existing
credentials and explicit `envKey` values retain their meaning. New setup uses
one OpenAI credential namespace and stores Responses models under `openai` with
`api: "responses"`. Existing legacy buckets are readable without rewriting
user files. Explicit reinstall replaces matching legacy routes in the canonical
`openai` group, retaining unrelated legacy entries. `api` is routing metadata and is never forwarded in request bodies.

## Runtime and setup design

Use one shared per-model protocol resolver for registry ingestion, startup
configuration, credential lookup, setup inspection, and model editing. Preserve
the existing effective `(authType, model id, configured baseUrl)` identity.
Two entries with the same model and URL but different APIs remain distinct.
Duplicate entries for the same effective route keep the existing first-wins
policy. Provider installation must also compare effective API when merging.

Raw startup selection of `openai` can select an explicitly configured Responses
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
changed route when necessary. Restart may resolve the newly edited startup
configuration. Existing session records need no new field because their
effective auth type already distinguishes both APIs.

Ink and OpenTUI share the provider setup hook; both must present API selection
and show the exact persisted configuration in their preview. VS Code and Web
Shell must expose the same choice. Web Shell keeps its existing credential
placeholder preview; the API, provider group, and effective auth must match the
installed routing metadata. ACP and daemon installation inputs accept
`api` and validate it before writing settings. ACP authentication labels use
shared OpenAI key terminology while legacy method ids continue to route
correctly. Model removal matches each entry's effective protocol and must not
clear the active selection when deleting its other-API sibling.

Implementation areas: core model types/registry/config and provider install;
CLI configuration/auth lookup and hot reload; setup views; ACP and daemon
installation contracts; SDK daemon request types; settings schema and user
documentation. No daemon route ownership or workspace-resolution rules change.

## Validation and acceptance

- Unit tests cover the compatibility table, invalid inputs, mixed API entries,
  exact endpoint credentials, install merge, and transactional registry reload.
- Configuration tests cover initial `openai` selection resolving Responses,
  explicit route precedence, model switching, and recorded session restoration.
- Setup tests cover API selection, preview/write parity, shared credentials,
  legacy inspection, request validation, and deletion of only the intended API.
- An isolated localhost server records actual CLI endpoint paths and payloads:
  legacy Chat, explicit Chat, canonical Responses, custom-provider Responses,
  legacy Responses, invalid API rejection, and Responses tool continuation.
- Dry-run the plan against global `qwen`, then verify the built local CLI. Use
  temporary `QWEN_HOME` directories and mock keys; do not modify real settings
  or send test prompts to a remote model.
- Run build, typecheck, focused unit tests, bundle, formatting/lint checks, two
  clean self-audit passes, and independent review before declaring completion.

Acceptance requires correct request formats and preserved route identity, not
merely successful JSON parsing or a zero exit code. Detailed execution results
live in `.qwen/e2e-tests/model-api-selection/`.
