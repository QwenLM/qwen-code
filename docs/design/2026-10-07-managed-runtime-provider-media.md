# Managed Runtime Provider Media Delivery

[English](2026-10-07-managed-runtime-provider-media.md) | [简体中文](2026-10-07-managed-runtime-provider-media.zh-CN.md)

Status: provider/1 implemented; production deployment acceptance tracked separately.
Date: 2026-10-07
Issue: [#13039](https://github.com/QwenLM/qwen-code/issues/13039), including the [root-cause comment](https://github.com/QwenLM/qwen-code/issues/13039#issuecomment-5895577269).
Code baseline: `a764fb9698e6e1152e0a8bc5808c30a765744152` for both upstream and local.

## 1. Decision and scope

Enable `read_file` to deliver real images and PDFs through the existing
`managed-runtime-provider/1` worker, Java Runtime Broker, and
`BrokerManagedRuntimeProvider` client. Preserve the seven-field prepared
reference, approval, preflight, original execution observations, and release
protocol. The Runtime receives only modality booleans, not model configuration,
prompts, credentials, or model-interface access.

Tool description and actual file reads both use
`Config.getEffectiveInputModalities()`. Add a worker-owned inline media ceiling
to the existing ReadFile path. Response fitting preserves valid media;
over-limit reads return an explicit, settled tool error.

This issue implements the provider path; it does not migrate every Hosted tool
profile. The public Hosted file loop currently uses raw Tool v2 and a separate
64 KiB inline Session resource. Replacing that loop, opening public media, a new
artifact API, audio/video delivery, Vision Bridge inference inside the Runtime,
and object-storage media transport are all separate changes. Successful provider
delivery does not prove those capabilities exist.

## 2. Current contract and defects

| Scope                                                                   | Verified baseline behavior                                                                                                                                                                          |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `managed-runtime-provider-worker.ts:createRuntime`                      | Creates an execution Config with no content generator. The media-bound ReadFile only covers `getEffectiveInputModalities`.                                                                          |
| `fileUtils.ts:processSingleFileContent`                                 | Reads `getContentGeneratorConfig()?.modalities`, so images remain unsupported, and native PDF and PDF-to-image fallback are unavailable; PDF text extraction already exists.                        |
| `managed-tool-runtime.ts:prepare`                                       | Copies `mediaContext` and includes it in the preparation digest; changing media context on a live invocation conflicts.                                                                             |
| `managed-runtime-provider-protocol.ts` / Java `ProviderRuntimeProtocol` | Closes `mediaContext: { inputModalities }` and allows boolean keys `image`, `pdf`, `audio`, `video`. Normal responses, including execute/status/cancel, are 1 MiB; historical operations are 8 MiB. |
| `fitManagedRuntimeProviderResult`                                       | Evicts progress and truncates text, and finally replaces non-truncatable inline media with a generic stub; it operates on the HTTP copy, not the execution result retained by the Runtime.          |
| Java `HttpRuntimeTransport`                                             | The seven-field reference selects provider execute/status/cancel; the four-field raw Tool v2 uses a different route and result shape.                                                               |
| `managed-tool-media.ts`                                                 | The larger validated-media exception belongs to ACP/raw Tool v2, not provider/1, and does not raise its 1 MiB ceiling.                                                                              |
| `hosted-workspace-tool-turn.ts`                                         | Public Hosted file selection uses raw v2; the persistent outcome/message limits can independently reject media and are not determined by transport success.                                         |

The issue comment suggested overriding content-generator configuration. This
design prefers the existing effective-modality getter: a production Config
returns modalities from the same resolved configuration by default, avoiding
forged model and auth configuration for execution workers. The
`getContentGeneratorConfig()?.modalities ?? {}` fallback is retained only for
existing local Config test doubles that do not implement the effective getter.
An empty object from the effective getter is authoritative; the fallback must
not re-enable a modality that was turned off.

## 3. Architecture and sequence

```mermaid
sequenceDiagram
    participant H as Harness/provider caller
    participant B as Java Runtime Broker
    participant R as Provider worker
    participant F as Workspace ReadFile
    H->>B: prepare(identity, read_file, input, mediaContext)
    B->>R: authenticated provider/1 prepare
    R->>R: copy and bind modalities for this invocation
    R-->>B: seven-field prepared reference
    B-->>H: seven-field prepared reference
    H->>B: confirmation / confirm / preflight
    H->>B: reserve / start(reference)
    B->>R: execute the original prepared reference
    R->>F: read under the fixed worker media budget
    F-->>R: valid inline parts or an explicit bounded tool error
    R->>R: retain terminal execution evidence
    R-->>B: bounded provider execution result
    B->>B: persist the original execution result
    B-->>H: original result containing inlineData
    H->>H: consume through the existing model-side media conversion
    Note over H,R: a lost reply only queries status for the original reference; it does not reread
```

Routing continues to follow current ownership: worker control belongs to the
live-session-owner; Broker start/status/cancel uses persistent execution
ownership and the original Runtime generation. `mediaContext` expresses model
capability and does not grant file permission. Existing workspace
authorization, session binding, approval, and file-service checks remain in the
read path. A model change only affects new preparations.

## 4. Modality binding and read semantics

1. Resolve and copy the existing media context during prepare. An omitted context
   preserves the worker's existing text-only media behavior, including PDF text
   extraction.
2. Create an independent derived Config for the invocation. This provider profile
   enables image/PDF only when the copied corresponding boolean is true;
   audio/video remain disabled even if the model supports them. Description and
   execution use the same effective view. Do not modify the Session or
   process-global Config, do not initialize the generator, and do not infer
   capabilities from model names.
3. Preserve the file service, target directory, permission rules, disabled read
   cache, and file-history service. Non-ReadFile tools continue to reject
   `mediaContext`. Do not register `zoom_image` or advertise zoom capability that
   this four-tool worker does not have. Fix `isOmniEnabled` to false on the
   worker's derived Config so inherited environment switches cannot load the
   media upload flow. A normal local CLI Config keeps the existing Omni behavior.
4. Change `processSingleFileContent` to read modalities through the effective
   getter. Local CLI/Legacy continues to use the existing resolved modalities.
   The local Managed factory already overrides this getter and must be
   regression-tested, because it changes from affecting only the description to
   also affecting the real read.

| Input and capability                    | Required result                                                                                                                                           |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supported image, `image: true`          | Reuse the native overview and safe-format handling, and deliver a valid image inlineData within budget; preserve existing corrupt/unsafe-format messages. |
| Image with image disabled or omitted    | Existing unsupported-image message, no inline bytes.                                                                                                      |
| PDF without `pages`, `pdf: true`        | Deliver native `application/pdf` inlineData when it fits; otherwise an explicit FILE_TOO_LARGE with guidance to use `pages`.                              |
| With `pages`, or without native PDF     | Existing text-first extraction and token/page checks; text-only models can still read text PDFs.                                                          |
| Scanned/high-density PDF, `image: true` | Existing page rendering, constrained by the smaller provider aggregate budget.                                                                            |
| Audio/video                             | Existing unsupported message, no inline bytes, no remote upload.                                                                                          |
| SVG/notebook/text                       | Preserve existing non-media behavior and permission rules.                                                                                                |

The generic manifest does not promise delivery of every media type. A
preparation with media and the actual output are the acceptance evidence. The
Harness caller passes the resolved capability snapshot through the fifth
parameter of the existing `ManagedToolV2Client.prepare`; the published Hosted
raw loop is not currently a production caller of that parameter. The default
product capability must not be claimed open merely because the client can
forward it.

## 5. Byte policy and terminal observability

provider/1 remains 1 MiB. The first-version policy is fixed in worker code; it
adds no public configuration or caller budget:

| Budget                                   | Unit and value                                                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `MAX_PROVIDER_INLINE_MEDIA_BASE64_BYTES` | The sum of all inlineData base64 strings is 768 KiB, at most 576 KiB decoded; the inflation formula is `4 * ceil(decodedBytes / 3)`. |
| `MAX_PROVIDER_MEDIA_RESULT_BYTES`        | The complete ReadFile ToolResult is 896 KiB as UTF-8 JSON, including text, MIME/display metadata, and returnDisplay.                 |
| Existing provider response ceiling       | 1 MiB, including protocol, complete session identity, execution/status wrappers, and retained progress.                              |

These are transport ceilings and do not prove a specific model still has enough
context. The Harness continues to enforce its own model and persistent-store
checks. The 896 KiB check only constrains results that intend to deliver inline
media. Text, SVG, notebook, and text-extracted PDF results continue to use
existing text fitting, including legitimate text results larger than 896 KiB.

Add an optional trusted construction-time read policy to `ReadFileTool`, passed
through `ProcessSingleFileContentOptions`. Only the provider worker sets it;
local callers omit it and keep the current limits. It is not a tool parameter and
cannot be enlarged through `mediaContext` or user settings. Apply it internally,
before returning inline parts:

- Native PDF and raw-image reads constrain the actual bytes read, not just
  `stat.size`; a growing or replaced stream is rejected after at most the decoded
  limit plus one byte. Handles are closed on success, failure, and abort. The new
  helper must preserve existing file-service and permission semantics.
- Image overviews measure the actual rendered Buffer before allocating base64.
  Preserve existing source-file/decoded limits; this feature introduces no
  arbitrary re-compression, resolution reduction, or new formats.
- Add an optional aggregate base64 ceiling to the existing PDF renderer. The
  smaller policy also constrains the first page; the current "first page is
  always retained" exception no longer applies. Stop before a page that cannot
  fit in the read/encoding budget. With an explicit page range, reject incomplete
  renders; without a range, allow only a whole-page prefix with an explicit
  notice that later pages were omitted, and return FILE_TOO_LARGE if not even one
  page fits, preserving the specific single-page over-limit cause and
  recommending a smaller page or a smaller document. When the document page count
  is known, clamp the explicit range's end page to the actual count and report
  the document length; an unknown page count or a genuinely missing page still
  rejects an incomplete render.
- Check both the encoded size of the complete media-bearing ReadFile ToolResult
  and the media bytes. Do not truncate base64, split PDF bytes, replace
  successful images with a generic success stub, or silently drop pages.

Pass the invocation AbortSignal into the `pdfinfo`, `pdftotext`, and `pdftoppm`
operations owned by this call. `extractPDFText` already accepts a signal, but
fileUtils must actually pass it; the renderer and page-count helper gain the
same optional signal. Reuse `execCommand`/`execFile` cancellation, and normally
wait for the owned child to exit and the renderer `finally` cleanup before
returning cancellation. After cancellation, wait at most 1 second, then send
SIGKILL; if close still does not arrive, wait at most another 1 second, unref the
process and stdio event-loop handles, and reject the call, avoiding an unbounded
wait. The renderer `finally` still performs cleanup; an OS process that cannot
exit is not guaranteed to disappear immediately. Abort must be rethrown, not
interpreted as an extraction failure that starts another fallback. The current
helper can return abort as a failure value, so the signal must be checked
explicitly after await, including before entering any fallback. Web Fetch
deletes the unused persisted file when PDF extraction is cancelled and refunds
its disk budget after a successful delete; cancellation continues to propagate.
Do not bind a single invocation's signal to the shared availability probe
Promise; those remain bounded shared probes. Tests cancel after each child
process has started, not only before ReadFile execution.

Read budget errors use a normal `ToolResult.error` and
`ToolErrorType.FILE_TOO_LARGE`, and the Runtime records `executionStatus: error`.
Return a settled provider observation through HTTP 200 so the Broker saves the
result and releases ownership, rather than turning it into a transport 413 or
UNKNOWN. Malformed/over-limit protocol input continues to use existing rejection
rules; a transport failure does not prove the read settled.

The response fitter may evict progress and trim auxiliary fields, but execute and
settled status/cancel must preserve the complete accepted media-bearing
ToolResult byte-for-byte. Error classification happens inside ReadFile, before
`ManagedToolRuntime.run` retains the terminal state, and must not manufacture a
different terminal delivery error in the HTTP copy. The 896 KiB ToolResult leaves
128 KiB for wrappers and bounded auxiliary data; remove progress first, then
reuse existing auxiliary fitting. Boundary tests must use a complete valid
identity and the real execution/status wrappers to prove an admitted media
result cannot enter the generic media-stub branch. If an anomalous result
violates this invariant, reject it as a protocol fault rather than rewriting or
ACKing the retained terminal evidence; this is an implementation error, not an
ordinary size rejection. Do not add a second media projection cache or
settlement state. The same reference must expose the same accepted model content;
observations must not reread the file. After trimming Hook auxiliary fields,
preserve a stop reason and Hook error that fit; if still over limit, first replace
the largest diagnostic with an explicit omission notice. The fitter mutates the
caller-held HTTP copy and may already have trimmed auxiliary fields before
rejecting the response wrapper; the caller must discard the rejected copy. Reuse
existing MIME/canonical base64 validation where possible, recognize only known
inlineData leaves in llmContent, and do not exempt arbitrary metadata media.
Java and TypeScript wrapper limits must stay consistent.

## 6. Storage, compatibility, and failure boundaries

Java stores bounded provider results in the existing tool execution ledger; no
schema change or media table is needed. Media is private tool evidence: do not
copy base64 into public token events, previews, logs, or error diagnostics. File
content is untrusted data and cannot provide execution instructions.

Keep providerProtocol `/1` and the request/response shapes, because this only
fulfills the existing mediaContext capability within the existing ceiling. An
old worker's unsupported placeholder is identifiable during acceptance and must
not be silently retried through Legacy or raw v2. The Harness's raw-v2 media
ceiling is larger, so the provider must not send a larger response because of it.

When the caller's Session contract requires persistence, the exact accepted
result must be committed before continuing to the model. The public Hosted raw
file path's 64 KiB outcome/history limit cannot accept a 768 KiB provider
payload. This design does not enlarge or bypass it. A future public Hosted media
profile needs independent raw-tool modality binding and persistent media
resource/message representation; a workspace path or public artifact preview
alone is not model-recovery evidence.

status/cancel use the original prepared reference. After an execute reply is
lost, status must recover the same media even if the file changed. After a
Broker restart, read the saved terminal receipt; if the worker is lost before
settlement, continue unknown and do not redispatch. release/new Turn eviction
retain the existing lifecycle. Media is bounded per invocation, but retained
invocation count can still consume substantial memory; acceptance covers that
cost and does not claim a new global quota.

## 7. Implementation slices

| Slice                         | Files and concrete changes                                                                                       | Exit check                                                                                                                             |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| M1: single capability source  | `packages/core/src/utils/fileUtils.ts`, provider worker media binding, local factory regression                  | Description and real read agree for image/PDF true/false/omitted, without depending on generator/credentials.                          |
| M2: bounded read policy       | `packages/core/src/tools/read-file.ts`, `utils/fileUtils.ts`, `utils/pdf.ts`, worker trusted construction policy | Real images, native PDFs, and rendered pages are deliverable; explicit size errors settle; local default behavior is unchanged.        |
| M3: retain media observations | `packages/cli/src/serve/managed-runtime-provider-protocol.ts`, worker routing, shared validator if needed        | execute/status/cancel retain media; progress does not cause a stub; malformed payloads are not exempt.                                 |
| M4: Broker and consumption    | `broker-managed-runtime-provider.test.ts`, Java `ProviderRuntimeTransportTest`, real-process driver              | A real provider worker and Java Broker deliver bytes to a fake multimodal provider; the original reference recovers across a lost ACK. |

M1-M4 do not modify public OpenAPI, SQL migrations, or Hosted profile selection.
After implementation, update the provider-control design in both English and
Chinese; its current placeholder description is a historical baseline, not
evidence of successful delivery.

M1 also adds `isOmniEnabled` to `DerivedConfigOverrides` in `config.ts`, set by
the worker override and read by file processing; it adds no public setting and
does not change the normal CLI Config default.

## 8. Verification and acceptance

Use small real PNG/JPEG/WebP/GIF and PDF fixtures to verify decoded bytes or
rendered MIME/dimensions, not just success, descriptions, or "contains no
placeholder". Fixtures live in the worker workspace; Harness decoy paths must not
be read. PDF coverage includes native bytes, explicit text pages, image fallback,
and missing Poppler. Renderer tests in the designated CI lane must actually run
Poppler; a skip is not positive evidence.

Must cover:

1. Core: effective getter precedence, local mock fallback, local CLI/Managed
   regression, modalities on/off, text/SVG/notebook behavior.
2. Worker: prepare different modalities in the same and different Sessions
   concurrently; retry conflict on changed context; omitted context must not
   inherit earlier capabilities; do not initialize model/auth/Vision
   Bridge/upload; permissions and workspace identity preserved.
3. Budgets: exact boundary and one byte over, base64 inflation/padding,
   multibyte/escaped metadata, multi-page aggregate including the first page,
   growing raw file, corrupt image/PDF, explicit page rejection/implicit prefix
   notice, cancellation and renderer cleanup.
4. Wire: real provider HTTP wrappers, maximum legal Session identity, chunked
   responses, execute with large progress and settled status/cancel; canonical
   base64/MIME rejection and over-limit non-media fields. Never split inlineData;
   never report a size rejection as successful delivery.
5. Integration: real packaged worker, Java Broker, and MySQL ledger. Drive
   provider controls through `BrokerManagedRuntimeProvider.getToolV2Client`, not
   raw v2. Assert the seven-field reference, provider/1 worker routing, and
   nested `result.llmContent`; do not use raw `responseParts`. Complete
   prepare/approve/preflight/reserve/start. Set
   `execution = await client.execute(reference)`, confirm success and a result,
   then pass `execution.result.llmContent` to `convertToFunctionResponse` in
   `coreToolScheduler.ts`, then through the existing Harness model conversion to
   a deterministic multimodal fixture, and inspect the real outbound request.
   Native PDF acceptance uses the existing Chat Completions converter
   (`application/pdf` becomes a file part), and its image conversion must also
   pass. The Responses converter currently supports image results but turns PDFs
   into an unsupported placeholder; verify that existing limitation separately
   and do not claim native PDF support on that route. No real model credentials
   are needed. Lose start/execute replies, change the file, query the same
   reference, restart the Broker, and check the original bytes and that the tool
   invocation executes exactly once. The first sniff/render may require multiple
   file reads; recovery observations must not add reads or processing. release
   after error/cancellation must still respond.

During implementation, run the repository build/typecheck/bundle, per-package
Core/CLI tests, Java Broker tests/Checkstyle, and the real MySQL process gate.
Distinguish these results from a real-model smoke test. Media delivery assertions
must fail when the effective getter or byte gate is removed, or when the fitter
drops inlineData.

Acceptance requires image and native PDF bytes to reach the model fixture through
the provider Broker path, PDF fallback to work, rejections to be bounded and
honestly classified, capability snapshot isolation, and original-reference
recovery consistency. Library tests or transport mocks passing alone do not
constitute #13039 completion.

## 9. Risks and follow-up decisions

- The 768 KiB aggregate ceiling intentionally supports a bounded subset of local
  CLI media sizes. Enlarging it requires a versioned end-to-end transport,
  storage, and capacity design; changing one receiver is not enough.
- PDF rendering and image decoding consume more memory/disk than the delivered
  payload. Before enabling in deployment, verify existing source-file/page/time
  limits and cumulative invocation retention; a bounded single response is not a
  global memory bound.
- Poppler is a deployment dependency for text extraction and scanned-page
  rendering; when missing, return an honest tool error.
- Public Hosted media, audio/video, object media, zoom, and custom ceilings each
  need their own consumer and contract; they are not implicit prerequisites for
  provider/1 image/PDF delivery.
