# Hosted Action input preview: Java-first rollout

[English](2026-10-04-hosted-action-input-preview.md) | [简体中文](2026-10-04-hosted-action-input-preview.zh-CN.md)

## Problem and scope

#13160 gates public foreground Shell admission in #13271: an approver must be able to inspect the tool input. The Harness already publishes `managed-tool-input`, but only the approval checkpoint references it. Java projects Actions from a closed `managed-action-options` version 1 resource, and transcript Items deliberately omit arguments.

This is the first rollout step: make Java accept version 2 options and expose a bounded input preview on both Action API surfaces. The Harness still emits version 1, and the WebShell card still uses its current transcript fallback. A subsequent change can emit version 2 and consume the preview after this reader is deployed. That writer must include the referenced input in the first Action commit: the HTTP resource closure currently follows checkpoints and extension records, but not Action options, and the Action commits before its checkpoint. Neither issue is closed by this step, and public Shell remains disabled.

## Contract and compatibility

Version 1 options keep their exact existing shape. Version 2 adds one `inputRef` field pointing to the call's already published `managed-tool-input` resource. All other fields, the approval policy and decision bytes stay unchanged. The `action.changed` envelope is unchanged; the reference is in its opaque options resource. Unknown versions and extra options fields remain rejected. At journal ingestion, validate the reference's closed shape, kind, schema version, length and digest against a committed resource in the same Session. Reject dangling references before they enter the authority journal: Workspace recovery recursively follows references in Action options. The stored options JSON already persists this reference, so no database migration is needed.

Deploy the Java reader before enabling a version 2 producer. An older Java reader rejects version 2 and would reject the approval's entire journal transaction. There is no negotiated options-version feature today; this step does not add a switch or a negotiation protocol. Version 1 producers and historical version 1 Actions remain readable and answerable.

## Preview and trust boundary

The public permission Action gains optional `input_preview` with `text`, `truncated` and `byte_length`; the WebShell equivalent is `inputPreview` with `text`, `truncated` and `byteLength`. Preview text is the exact `payloadJson` string stored in the tool-input wrapper, containing `{toolName,input}` as sent to the Broker. Java does not reserialize it: key order, escapes and numeric spellings remain intact. The full byte length counts this string's UTF-8 bytes. Text is a prefix of at most 8192 bytes, ending before an incomplete UTF-8 code point; it need not remain valid JSON when truncated.

Only requested Actions for native `read_file`, `write_file`, `edit` and `run_shell_command` receive a preview. MCP inputs contain internal grants and identities; they remain unavailable in this step instead of publishing those credentials. Unknown tool kinds also receive no preview. This is not general secret redaction: native write content and Shell command text remain visible within the byte bound to actors already allowed to read the Session.

All four list/detail routes retain `requireReadableSession` before projection. Reuse the committed inline-resource reader to enforce the tenant and Session scope, referenced state, reference metadata, stored length and SHA-256. A Session has one immutable journal Workspace scope; a reference cannot select another Session or tenant. Check kind `managed-tool-input`, schema version 1, strict UTF-8/JSON, the wrapper's Session identity and shape, and the payload's tool name against the Action. Missing, corrupt, malformed or mismatched input yields no preview and does not fail the Action read. Approval options, creator-only answers and transcript projection remain unchanged.

The Harness writer supplies the immutable binding between an approval and its captured invocation. Java validates the referenced resource, Session and tool; it does not reconstruct that binding from private checkpoints or argument-free Items. The producer follow-up must reuse the same captured input reference in the Action and checkpoint, and test distinct calls to the same tool so their inputs cannot be mixed up.

## Changes and validation

Extend the Java options reader, the shared Action projection and the existing committed-resource reader. Add the optional preview schemas to OpenAPI and regenerate WebShell types. Update the D6 Actions design in both languages to record this rollout.

The regression commits real version 2 Action journals and tool-input resources through the Session store, then reads public and WebShell list/detail routes. Verify exact small input, exactly 8192 bytes, 8193 ASCII bytes, and large input ending near a multibyte boundary. Reject malformed, dangling, mismatched and cross-Session/tenant references at ingestion. Then damage already stored references or resources to verify that reads still omit an unavailable preview. Also cover malformed payloads, unsupported MCP input and version 1 compatibility. Existing allow/deny, terminal settlement and access-control tests must remain green. The version 2 regression must fail on the prior Java reader before any preview is returned.

API response evidence is the observable result of this reader step. Browser preview rendering, real Harness version 2 emission, restart outcomes and public Shell enablement belong to the following stages; this step must not claim them as verified.

## Acceptance and follow-up

- A requested native-tool Action with valid version 2 options exposes the same bounded preview on public and WebShell list/detail APIs.
- Unavailable input never makes the Action unreadable. Unsupported options versions, shape changes and invalid input references still fail closed at ingestion.
- Version 1 Actions continue to be read and answered under the existing policy.
- Generated types match the contract; both languages describe the same limits and rollout order.
- Follow up with Harness version 2 emission and the WebShell card after deploying the Java reader, then re-evaluate #13271's remaining approval, crash and enablement gates.
