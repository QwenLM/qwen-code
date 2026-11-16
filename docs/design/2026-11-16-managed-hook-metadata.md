# Managed hook display metadata

[English](2026-11-16-managed-hook-metadata.md) | [简体中文](2026-11-16-managed-hook-metadata.zh-CN.md)

Status: implemented in this change. Addresses
[#17381](https://github.com/QwenLM/qwen-code/issues/17381).

## Problem

Managed extension preparation rejects a hook that carries the standard
`description` or `statusMessage` string. `stageManagedExtensionManifests()`
copies each contribution hook into the catalog, dropping only `once` and
`async`, then `ManagedHookRuntime` parses the whole catalog. `parseManifest()`
checks every config against a closed key list. None of the four lists includes
those two fields, so `closed()` throws `managed_hook_invalid` before the hook
can run. One such hook fails the entire `extension-prepare`.

Before this change the allowlists were:

- command: `type`, `name`, `command`, `timeout`, `env`, `shell`
- http: `type`, `name`, `url`, `headers`, `allowedEnvVars`, `timeout`
- prompt: `type`, `name`, `prompt`, `model`, `timeout`
- function: `type`, `name`, `timeout`

## Unchanged contract

`CommandHookConfig`, `HttpHookConfig`, `PromptHookConfig`, and
`FunctionHookConfig` each declare `description?: string` and
`statusMessage?: string`. The settings schema declares the same two optional
strings. The user guide lists both for command and prompt hooks, and lists
`statusMessage` for HTTP hooks. Listing and hook progress already read them in
the interactive runtime.

A non-string `name` is `managed_hook_manifest_invalid`. An unknown key is
`managed_hook_invalid`. Catalog descriptors narrow command, HTTP, and function
configs to `{ type, name? }`. Prompt descriptors pass the whole
`PromptHookConfig`. `getHookKey()` uses name plus command, url, prompt, or
function id. The extension catalog digest is the raw package contributions.
Exposed catalogs are bounded by 60 KiB.

Extension staging emits only command, HTTP, and prompt hooks. Function configs
arrive on a workspace base manifest.

## Decision

Accept both fields as optional strings on all four allowlists, using the same
rule as `name`. A present non-string value is `managed_hook_manifest_invalid`.
Every other unknown key stays `managed_hook_invalid`. An empty string is
allowed. There is no new per-field length limit; the existing 60 KiB catalog
bound remains the egress limit.

Command, HTTP, and function descriptors stay `{ type, name? }`. The strings
remain on the stored manifest so preparation succeeds, and they do not leave
the worker in those catalogs. Prompt descriptors already forward
`PromptHookConfig`, so a prompt catalog now includes the two strings together
with `prompt`, `model`, and `timeout`.

The function branch of `ManagedHookDefinition` gains the same two optional
strings. Staging is unchanged: it already copies every key other than `once`
and `async`. Planner keys and definition digests do not gain a new input.

The HTTP allowlist also accepts `if` as an optional string under the same
rule. `HttpHookConfig` and the serve hook contract already declare it and the
interactive runtime forwards it, so an extension HTTP hook carrying a
condition failed preparation with the same `managed_hook_invalid`, one key
over. The condition stays on the stored manifest and does not leave the worker
in the narrowed HTTP catalog. Deriving the allowlists from the core types is
left to a follow-up; the lists stay closed and hand-written.

## Out of scope

Managed command execution does not gain a progress channel for
`statusMessage`. The HTTP section of the user guide is left as it is. Issue
#13133 is a separate managed-hooks follow-up.

## Validation

- `packages/cli/src/serve/managed-extension-manifests.test.ts` stages the
  reported command hook, plus HTTP and prompt hooks, without the fields, with
  each field alone, and with both fields together, and expects those strings
  on the staged config. It also stages an HTTP hook with an `if` condition and
  expects the condition on the staged config.
- `packages/cli/src/serve/managed-hook-runtime.test.ts` accepts the strings on
  all four types and expects the parsed catalog pin to keep them. It expects
  command, HTTP, and function catalogs to expose only `{ type, name? }`, expects
  the prompt catalog to include the strings, rejects a numeric value with
  `managed_hook_manifest_invalid`, and rejects an unknown key with
  `managed_hook_invalid`. It accepts an HTTP `if` condition, keeps the
  condition out of the exposed HTTP catalog, and rejects a non-string `if`
  with `managed_hook_manifest_invalid`.

## Acceptance

- The reported `PostToolUse` command hook with `description` stages.
- `statusMessage` stages the same way for command, HTTP, and prompt hooks.
- A non-string value is `managed_hook_manifest_invalid`.
- An unknown config key is `managed_hook_invalid`.
- A command, HTTP, or function catalog does not contain the metadata text.
- A prompt catalog contains the metadata text and remains inside the 60 KiB
  catalog bound.
- An HTTP hook with an `if` condition stages and parses.
- A non-string `if` is `managed_hook_manifest_invalid`.
- An HTTP catalog does not contain the condition text.

## Open questions

None.
