# ACP resource link descriptions

[English](2026-10-12-acp-resource-link-description.md) | [简体中文](2026-10-12-acp-resource-link-description.zh-CN.md)

Status: implementation and local validation complete; delivery and application acceptance pending.

## Problem and scope

ACP retains the complete original `resource_link` for transcript consumers,
but the model receives only its URI and name. A caller cannot supply useful
reference context through the standard `description` field. This change makes
non-file link descriptions visible to the model without reading the resource.

Only `packages/cli/src/acp-integration/session/Session.ts` and its collocated
tests change. Transcript persistence, replay, SDK schemas, file resolution,
permissions, and product UI keep their existing contracts. Qwen does not
interpret application-specific URI schemes, metadata, callback routing, or task
relationships.

## Projection

Collect each non-empty, non-whitespace `description` as a separate text part:
`Resource link: <uri>`, followed by `Description: <description>` on a new line.
Preserve the description's original text. Keep the existing URI/name marker
and the order of all existing parts. The resolver places descriptions before
the existing parts when `promptLast` is true and after them otherwise, matching
its reference-context ordering. Apply media bridge conversion to the resulting
parts as before.

Links without a description, with an empty or whitespace-only description,
and `file://` links retain their previous model input. `_meta`, annotations,
title, and other link fields remain outside this model projection. Descriptions
are ordinary reference content, not permission grants or trusted instructions.

For an application sending collaboration requests and replies, its description
can explain the reference while its own link metadata records the relationship.
Qwen does not recognize or execute that application's request/reply protocol.
The application remains responsible for authorization, correlation, and
preventing reply loops.

## Validation and acceptance

The collocated tests cover ordinary links, request/reply description examples,
multiple descriptions, custom-command reference context, unchanged links
without usable descriptions, opaque metadata, and local/SSH file links.
Existing original-link recording tests
continue to cover persistence independently of model expansion.

An independent test engineer completed `npm run build`, `npm run typecheck`,
and `npm run bundle`, followed by the complete collocated Session test file:
`cd packages/cli && npx vitest run src/acp-integration/session/Session.test.ts`.
All 1,246 tests passed, including the nullable-description boundary.

The built 0.25.1 CLI passed nine ACP scenarios against a loopback OpenAI mock:
ordinary, request, reply, absent, null, empty, whitespace, opaque metadata, and
file. Captured model requests and actual ACP replies confirmed descriptions
appear once while original text and URI/name content remain intact. File
handling was verified through the client's allowlisted filesystem fixture.
The global `qwen` binary was unavailable, so no global baseline execution is
claimed. This verification does not exercise live providers or application callbacks.

The local E2E plan remains under the Git-ignored
`.qwen/e2e-tests/2026-10-12-acp-resource-link-description.md` path. No
dependencies or external API contracts change.

Acceptance requires descriptions to reach the model exactly once, original
URI/name parts to remain intact, blank descriptions and metadata to produce no
extra model content, and existing file handling to remain unchanged. Pending
queue restoration and application-level automatic replies are separate work.

## Open questions

None within this projection change. Deployment and application integration must
use a Qwen build that includes it.
