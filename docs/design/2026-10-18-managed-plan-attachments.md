# Managed Session Plan mode and input attachments

[English](2026-10-18-managed-plan-attachments.md) | [简体中文](2026-10-18-managed-plan-attachments.zh-CN.md)

## Problem and scope

Managed Web Shell currently disables the composer attachment and Plan controls. Its Java API and private Hosted prompt route accept text only, and enabling the controls alone would lose attachment contents or fail admission. Hosted team-member planning is a separate protocol that submits plans to a team leader; it does not implement user approval of a public Session plan.

Support Plan and bounded inline attachments in new and existing Managed Sessions. Reuse the shared composer, existing owner and Workspace authorization, immutable Turn inputs, Action decisions, and recovery machinery. Keep the selected execution permission independent from Plan. Do not change ordinary DAC/CLI planning, team-member planning, AgentDefinition identity, or the Workspace filesystem merely by attaching a file.

## Current state

Java stores normalized inputs in `ma_turn.input_json`, digests the entire input, and materializes user Items for transcript replay. Hosted stores the accepted prompt and admission as immutable resources. The model consumes durable message parts during history replay, but the current initial prompt is flattened to text. Resources and prepared model snapshots have a 64 KiB inline limit.

Session approval selection already has owner authorization, Workspace OPERATOR access, idle and recovery barriers, an idempotent receipt, CAS revision, and a frozen per-Turn execution policy. Native file tool approvals have durable v3 continuations; ordinary Shell, MCP and Hook batches are not all recoverable through that continuation format.

## Plan state and public API

Add migration `V10__session_plan_mode.sql` without rewriting published migrations. Add `ma_session.plan_enabled` with default false and nullable `ma_turn.plan_enabled` for the immutable snapshot. Reuse `approval_revision` for the complete selected execution policy and Plan state. A Plan toggle increments the revision and records the current execution mode in `selected_approval_mode`, preserving the existing selection constraint. Turn admission copies mode, revision and Plan under the existing Session row lock.

Extend the existing Web Shell approval query/change, summary and creation contracts with `planMode`; expose `planModeSupported` separately. An omitted change field preserves the existing Plan value. The original definition approval mode remains unchanged. Use the current owner plus OPERATOR requirement and idle barriers for toggling; an active Turn or pending approval cannot be manually changed. A manual idle exit does not approve any plan. Permission changes preserve Plan and never answer an Action.

Plan is available only to the public Workspace profiles already supporting approval selection: `hosted-workspace-files/1`, `hosted-workspace-shell/1` and `/2`, for built-in and stored definitions. Child, team, workflow, unbound, MCP and Hook profiles are not extended by this feature. Preserve their existing behavior.

## Hosted Plan execution and approval

Add capability `plan-mode/1` and an optional `planMode: true` in the immutable private approval selection. Omit the field for false and legacy Turns, preserving old wire identities. Java must require the capability before dispatch or active-Turn progression that carries Plan. A missing capability fails closed; it must never downgrade a Plan Turn to execution mode.

The tool turn derives its public Plan overlay from the admission and this Turn's durable allowed public `exit_plan_mode` Action. It admits only `read_file`, `glob` when present in the profile, and a dedicated public `exit_plan_mode` control call. All writes, edits, Shell commands, background work, child/workflow/team/message/MCP/skill effects are refused before execution, regardless of `yolo` or Hook permission. Known profile tools blocked by Plan return a read-only refusal. A call outside the underlying profile retains the existing guard and fails the Turn; neither path produces effects or releases Plan. Model instructions explain these restrictions. This first version deliberately does not classify remote Shell commands as read-only.

The public exit tool takes a nonempty Markdown plan and must be the only call in its batch. It always asks the human, even with `yolo`. Keep its declaration stable for a Turn that started in Plan. An allowed Action removes only this Turn's overlay; subsequent calls still use its frozen execution mode. Thus `default` may ask again before a write, whereas `yolo` does not. Denial, expiry and cancellation do not grant execution. A repeated exit after approval reports that planning already ended.

Extend v3 native continuation capture and validation only for the exact single public Plan exit control call. Preserve the existing restrictions on ordinary Shell/MCP/Hook batches. Save its exact input, tool declaration, assistant batch, model round, Action and Runtime generation. The control call must bypass Runtime reserve, prepare, intent and execute. Recovery resumes the original Action and journals its result; it does not ask again or infer authorization from an in-memory flag. Keep existing Runtime acquisition, cleanup and fencing requirements.

When Java projects a valid allowed public Plan Action, verify its input/Turn association, `plan_enabled` snapshot and matching approval revision. In the same SQL transaction, clear Session Plan and increment the Session revision, leaving the Turn snapshot untouched. Public Plan exit requires the recorded Session owner with current OPERATOR access on both file and Shell profiles. Late or unrelated Actions cannot clear a newer selection. This makes refresh and process restart observe the completed transition.

## Attachment contract and model input

Extend the closed public input union with `input_file` carrying `name`, `mime_type`, UTF-8 `text`, and `input_image` carrying `mime_type`, base64 `data`. Existing `input_text` and legacy `text` retain their behavior. Reject mixed or unknown fields, empty attachments, arbitrary URLs, host paths, binary files, malformed base64 and mismatched image signatures. Text attachments use a conservative text MIME/extension allowlist and reject NUL. Images support PNG, JPEG (including the `image/jpg` alias), GIF and WebP, matching ordinary Qwen Code's `PIPELINE_IMAGE_MIME_TYPES`. PDF, Office documents, audio and video are outside this change.

Apply the same image formats in the Managed composer and restored drafts, public OpenAPI contract, Java admission and Hosted parsing. Accept both `GIF87a` and `GIF89a` signatures, and validate `image/jpg` with the JPEG signature. Canonicalize the JPEG alias to `image/jpeg` before creating durable input or model parts and when restoring composer thumbnails, matching ordinary image ingestion and downstream provider/display requirements. Preserve original image bytes and canonical MIME types through digests, replay and projection. Align with the ordinary model-input pipeline rather than its broader file-recognition list; BMP, TIFF, HEIC and SVG image blocks remain unsupported. No transcoding or new storage is required. Deploy the UI, Java service and Harness together before relying on GIF or `image/jpg`; older validators reject them.

Normalize files into inline ACP text resources with a generated non-host URI and images into ACP image blocks. Include every attachment byte and its name/MIME in semantic and payload digests. The canonical JSON of a request containing attachments is limited to 8 MiB, including text; Java and Hosted enforce the same limit. Hosted checks the exact attachment user message against a 9 MiB budget and stores it through existing message chunks. The [attachment budget design](2026-10-18-managed-attachment-budget.md) defines dedicated input/model-resource and browser-persistence budgets. Ordinary resources keep their existing limits; do not introduce an upload service, new storage table, automatic truncation or omission.

Advertise `input-attachments/1`. Non-text dispatch requires it; text-only requests remain compatible with older Harnesses. Convert the accepted immutable input to the same model parts for user journaling, initial generation, hooks and restoration. Text resources are presented with an explicit filename boundary; images become `inlineData`. Hook updates to the user's text retain attachment parts. Validate image support after applying the final pinned/selected model configuration, including retained image history; a text-only model must fail explicitly instead of receiving an unsupported-image placeholder.

User Items retain canonical attachment metadata/content through the existing JSON attributes and resource references. Live events, transcript pages, snapshot/resync and refresh reconstruct the same file/image presentation. Attachment selection does not write files into the Workspace; a later model tool call remains subject to Plan and execution permission.

## Composer and retry behavior

Opt Managed composers into the shared add menu, Plan control and attachment ingestion. New Session creation captures its Plan selection before the first Turn. Existing Session state comes from the backend, and toggles use the existing persisted approval-change state machine and readback. Hide the composer under the existing approval overlay, display the submitted plan, and label approval with the frozen execution policy.

Allow attachment-only submission. Encode Blob inputs and validate size, MIME and UTF-8 before constructing an idempotent pending request. Persist the complete canonical input with its request key and Session identity. Refresh and unknown-delivery retries reuse the same snapshot rather than rereading a Blob. Clear the composer only after accepted admission; errors retain the draft and never silently discard an attachment. Scope pending data by provider, tenant, actor and Session, retaining existing uncertainty handling.

## Affected areas

- Web Shell Managed provider types, generated Java API types, composer integration, creation/pending-request state, Action presentation and transcript projection.
- Java API/OpenAPI, input validation, approval selection, Turn admission, Action projection/authorization, read models and capability gating.
- Shared schema V10 and Server/Broker initialization/validation.
- Java SDK private approval selection and Hosted client capability checks.
- Hosted prompt parsing, model parts/capability validation, public Plan tool enforcement and exact-single-control continuation recovery.

## Rollout and limits

Capabilities are pinned when the Java Harness client is constructed. If an unsupported generation has already been negotiated, restoring support requires restarting the control plane to construct a new client; a blocked Turn does not automatically probe or bypass its missing capability. Stop or isolate old Server/Broker binaries sharing the catalog before enabling Plan. Apply the additive V9-to-V10 migration only after a backup and isolated migration test. Deploy compatible Java, SDK, Harness and UI together. Old binaries cannot safely operate a catalog containing enabled Plan selections. Keep existing data, Workspace bindings, credentials and immutable definition identity.

8 MiB is a single-input budget, not an unlimited conversation guarantee. A prepared model request includes history, tools and system instructions and can still exceed its 32 MiB snapshot budget. Preserve existing explicit recovery limitations in that case; do not claim full recovery or silently drop history. Large-file/object storage, remote Shell classification, extra composer actions, cross-profile inheritance, Linux Hook/cgroup certification and real upstream model certification are not included.

## Validation and acceptance criteria

Use an isolated worktree, disposable MySQL 8.4 databases, separate ports and Workspaces, and deterministic local model responses. Never run tool-effect tests in the user's actual Session or reset its database. Dry-run the E2E plan against global `qwen`, recording unsupported baseline paths honestly. Verify the built artifact with the test-engineer agent.

Exercise new/existing built-in/custom Sessions, all three execution modes, Plan reads and zero-effect refusals, approve/deny/cancel/expiry, stale CAS and receipt replay, owner/grant isolation, Plan Action refresh, and crash recovery before/after its decision/result. Verify approved execution still uses the frozen permission and old Actions do not release a new Plan. Regress team-member planning and native approvals.

Exercise text/image/file-only input, strict invalid shapes, MIME/encoding/signature and size boundaries, complete-input digest conflicts, old capability refusal, final model image support, Hook text updates, unknown-delivery refresh, transcript/snapshot/resync and subsequent history. Verify GIF87a/GIF89a and `image/jpg` admission, exact replay/projection/model bytes and canonical MIME types, alias normalization in restored drafts, and parity with the ordinary pipeline's format list. Reject mismatched or truncated GIF headers, malformed base64 and unsupported image formats. Test a recoverable small prepared request and record the existing snapshot ceiling separately.

Run affected Java unit tests, API/SurfaceRegistry tests, SDK tests, full Java verification, real MySQL and matching Hosted recovery profiles; root build/typecheck/bundle, focused CLI/Web Shell tests, generated contract consistency, formatting and two clean self-audit passes. Independently review the full change before updating the local deployment. Report unavailable lanes explicitly.

## Open questions

None for this scope. Any implementation-driven correction must update both languages and the E2E plan before validation.
