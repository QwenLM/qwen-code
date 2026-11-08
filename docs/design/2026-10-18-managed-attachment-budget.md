# Managed attachment budget

[English](2026-10-18-managed-attachment-budget.md) | [简体中文](2026-10-18-managed-attachment-budget.zh-CN.md)

## Problem and scope

The 48 KiB inline input limit prevents ordinary screenshots and small text files. Support approximately 5 MiB of attachments per submission, preserving exact input bytes, idempotent retries, message projection and bounded model recovery. This extends the attachment contract in [Managed Plan and attachments](2026-10-18-managed-plan-attachments.md).

## Budgets and storage

Allow 8 MiB for the complete canonical UTF-8 JSON input, including text, names, MIME types and base64 images. This accommodates a 5 MiB image and its base64 overhead. Keep existing file-format and model-image-capability checks.

Only `managed-input` may use an 8 MiB inline resource and `hosted-model-request` a 32 MiB inline resource. Other kinds retain their existing 64 KiB limit. Keep user records on the existing 60 KiB message chunks, allowing an attachment user record up to 9 MiB for metadata and text-file wrappers. Separate the aggregate inline-resource transaction limit (40 MiB) from the unchanged 8 MiB journal-record transaction limit. Existing LONGTEXT and LONGBLOB columns need no schema migration.

Model snapshots include history and the prepared request, which can contain the same image twice. Increase their capture and read budget to 32 MiB; keep other recovery descriptors at 64 KiB. Preserve digest, tenant, Session and activation checks. Receipt checkpoint snapshots remain bounded at 128 MiB decoded and 192 MiB JSON, including all resources; per-kind validation still applies.

The public signed-body limit and daemon request-body limit remain 10 MiB. Internal Session Store commits use their existing writer credentials and do not pass through public signature authentication. Allow the internal commit JSON decoder to accept the bounded base64 representation of a 32 MiB resource; downstream per-kind and aggregate checks remain authoritative.

## Browser retry persistence

Keep small pending requests in sessionStorage for compatibility. Store large pending requests in IndexedDB, with a random per-tab reference in the same existing sessionStorage key. Commit IndexedDB before publishing the reference and before making any API request. Await restoration before enabling submission, preserve the exact original idempotency key and canonical input, and clear the stored body after admission or explicit discard. Storage failures continue to prevent submission. A cloned tab can retain a pointer after another tab clears its body. Failed restoration keeps automatic submission blocked and offers explicit local discard after warning that the previous submission may already have succeeded; it never silently starts a fresh request.

## Affected areas and rollout

Update the Managed composer input and pending-request paths, Java input/OpenAPI validation and Session Store resource budgets, Core HTTP resource publication and recovery parsing, Hosted admission/model capture, and receipt checkpoint readers. Regenerate Web Shell API types from OpenAPI. Deploy compatible Java and Harness readers and writers together before relying on the larger budget; older binaries still reject the larger inputs. No upload service, object-storage integration or new file formats are included.

## Validation and limits

Verify a roughly 5 MiB PNG and a text file above 48 KiB, full canonical-input rejection above 8 MiB, exact pending restoration across refresh under a realistic sessionStorage quota, Java admission/replay/projection, per-kind resource limits, message chunks, model-request capture/read and checkpoint inspection. Run focused tests, root build/typecheck/bundle and the affected Java verification. Distinguish deterministic/local checks from real-provider and deployed acceptance.

Input size does not guarantee an unlimited conversation: model snapshots, checkpoint exports, provider context windows and Function Hook message budgets remain finite. Preserve their explicit rejection or recovery-blocked behavior without truncating history or attachments. There are no open product decisions; the chosen target is approximately 5 MiB per submission.
