# Unified Multimodal Layer (media)

Status: P0–P5 implemented (everything except the generation track PG) on
`feat/unified-multimodal-layer`.

This implements the unified multimodal understanding layer described in the
omni_harness design docs (`需求与设计-统一多模态理解.md`,
`方案-统一多模态层与媒体记忆.md`, `实施计划.md`). It follows the three beliefs:
cross-session media memory, "assumptions expire → pluggable", and "one interface

- config selects the implementation + an effort knob". Reads reach the model over
  the existing tool-result media path; the one core-hotspot change is Seam B
  audio/video history governance in `geminiChat` (additive, mirrors the existing
  image-payload eviction).

## What is real (not scaffold)

- **Probe** fills duration / resolution / **fps** / audio-track / audio-channels
  via `ffprobe` (best-effort; images are probed for dimensions too).
- **Refinement knobs actually apply** (ffmpeg): image `region` (crop) / `scale`
  / provider long-edge cap; audio/video `range` (clip) and `fps` (sampling).
  Every reduction is declared in the C10 `precision` note. The default decision
  policy makes range/fps/region/scale/effort **model-owned** (they now do
  something), so `image_view` / `media_watch` expose them.
- **Effort ladder** (`media-effort.ts`) maps low→max to concrete choices
  (keyframe count, frame long-edge, segment count, image-cap scale) across the
  native reader, keyframe extractor and `media_dispatch`.
- **Upload backends** (`core/media/uploader.ts`): `command` (run any upload CLI
  that prints the public URL — aliyun/aws/rclone, dependency-free) and `http`
  (PUT bytes to an endpoint, reference by public URL). Default stays fail-closed
  with a remedy. Selected by `media.upload.backend`.
- **Per-provider media profiles** (`provider-media-profiles.ts`): qwen-vl /
  gemini / anthropic / openai, selected by auth type (with a DashScope base-URL
  sniff), carrying image long-edge caps, per-modality token estimates, and
  whether the provider can fetch a `fileData.fileUri`.
- **Delegated backends** (`delegated-reader.ts`): `command` (local ASR/OCR CLI),
  `subagent` (one-shot multimodal understanding call — image/keyframes/audio →
  a vision model), and `mcp` (route to a discovered MCP tool). All fail closed
  with a remedy.
- **`media_extract`** (`media-derive.ts`): `keyframes` / `audio_track` / `clip`
  run locally via ffmpeg and are written to a **content-addressed derived store**
  (`media-memory/derived/<hash>.<ext>`) — each artifact is a first-class media
  file with its own hash + memory record linked back to the source
  (`derivedFrom`), searchable via `media_grep`. `transcript` routes to the
  delegated understanding/ASR backend.
- **P0 anti-pattern fixed**: computer-use screenshots now disclose their
  downscale cap (and how to get full resolution) on every screenshot part, not
  only on failure; rendered PDF pages disclose the per-page 1600px downscale.
- **Seam B (a/v)**: `image-payload-references.ts` now evicts inline audio/video
  payloads from prior turns to a memory-pointing text reference (no reattach —
  bytes too large; the current turn is preserved). This bounds token cost,
  prevents duplicate injection, and survives model switches. Wired into
  `geminiChat.getRequestHistory`.
- **P5 skill media** (`media-references.ts`): media files referenced in a skill
  body are surfaced through the unified read interface on skill load
  (summary-first with prior understanding + how-to-pull, or inline bytes per
  `media.injection.mode`), confined to the skill directory.

## Large files & oversized video

Probe fills duration/resolution/audio-track/fps via `ffprobe`. Files past the
inline limit try the configured upload backend first (when the provider can
fetch a URL); when none is configured, a video falls back to **local `ffmpeg`
keyframe extraction** — a handful of downsampled frames delivered inline with an
explicit LOSSY precision note. Reading an oversized media file through the shared
read path (`@`-mention / `read_file`) is **memory-first**: it recalls any prior
cross-session understanding (by absolute path) or names the media tool to use,
instead of a bare "too large" error.

## media_dispatch (parallel time-segment understanding)

`media_dispatch` splits a video into time segments and understands each in
parallel: per segment it extracts keyframes (`ffmpeg -ss/-to`) and runs one
understanding call, then aggregates the notes and records a combined
understanding in media memory (searchable via `media_grep`). It picks the
understanding model as: the **main model when it is multimodal**, otherwise a
configured vision model — so it works whether or not the main model can natively
ingest images, and a multimodal main model still benefits from divide-and-conquer
over a long video. Concurrency is bounded; a failed segment degrades to an error
note rather than failing the whole call.

**Prompt + memory-first caching.** `media_dispatch` takes a `prompt` parameter —
what to extract per segment (default: a general factual description; the model
sets it to target the question, e.g. "identify any team/brand/logo/credits").
Results are cached per **(content hash, prompt)**: asking the _same_ question in
a later session returns the stored understanding instantly with **no model
calls**; a _different_ question is a cache miss that runs a fresh targeted
analysis and **accumulates** into the same file's memory (增厚). Pass
`force: true` to re-analyze. This realizes the intended flow — answer from
memory first, only re-analyze when the question needs information not yet
captured. (Recall still depends on the model passing a comparable prompt or
calling `media_grep`; the harness caches, it does not judge semantic
equivalence.)

## Memory: when it saves / loads

- **Save**: after every successful `image_view` / `media_watch` / `media_extract`
  read (provenance + any derived note), and once per `media_dispatch` run (the
  combined per-segment understanding). Keyed by content hash; understandings
  accumulate rather than overwrite.
- **Load**: (1) **memory-first on read** — reading a media file too large to
  inline goes through the shared `processSingleFileContent`, so it applies to
  every read path: the `read_file` tool, `@`-mentions (which expand via
  `readManyFiles`), and `pathReader`. Instead of a bare "too large" error it
  looks up any prior understanding **by absolute path** (`MediaMemory.getByPath`,
  no re-hashing of the large file) and returns it, or states there is none and
  names the media tool to use. `MEDIA_INDEX.md` records the source path too. (2)
  automatically — reading a file already in memory via `media_watch`/`image_view`
  surfaces its prior understanding as a note. (3) explicitly — `media_grep`.

## Layers and seams

```
tools/media/*            L1 orchestration (image_view, media_watch, media_grep, media_extract, media_dispatch)
utils/media/*            L2 provider-agnostic core (Seam A: reader registry, probe, policy, C10, keyframe extractor, dispatch)
core/media/*             Pattern P provider-coupled hard logic (transport, uploader, profiles)
memory/media/*           Seam C: cross-session media memory (store, index, links, recall)
```

- **Seam A — Reader Registry** (`utils/media/reader-registry.ts`): the socket
  for read implementations. Two generic executors: `native` (bytes straight to
  the model) and `delegated` (hand off to a declared subagent/mcp/command
  backend, get notes). Adding OCR/ASR/dense-caption = adding a declaration, not
  a core class.
- **Seam C — Media Memory** (`memory/media/*`): one record per file keyed by
  content hash, stored under `~/.qwen/media-memory/<hash>.md` with an
  independent `MEDIA_INDEX.md`, per-user and cross-project (Q7). Understandings
  accumulate; links are scaffold-built from deterministic signals (Q6).
- **Seam B — MediaContext (push injection + history governance): DEFERRED.**
  This is the only part that must touch core hotspots (`geminiChat`, history /
  compression). Per the plan it is a separate maintainer-led PR and does not
  block pull. See "Deferred" below.

## What each phase delivered

- **P0** — `utils/media/media-result.ts`: the C10 result/error contract. Every
  delivery states scope + precision + how-to-read-more (no silent quality loss);
  every error is fail-closed with a remedy.
- **P1** — probe (`probe.ts`), reader registry + `MediaReader` interface,
  native passthrough reader, capability gating (fail-closed), effort knob type
  reused from `core/reasoning-effort`. Tools `image_view`, `media_watch`.
- **P2** — transport decider + uploader (`determineUploader` + fail-closed
  `DefaultUploader`) + per-provider media profile (Pattern P). Cross-session
  media memory store/index + `media_grep`.
- **P3** — delegated reader executor (`via: command` runnable; `subagent`/`mcp`
  fail closed with a remedy until wired), decision knob/policy mechanism
  (`decision-policy.ts`), effort surfaced through the read params. Tool schemas
  are generated from the policy (a knob is only a tool param when the policy
  hands it to the model).
- **P4** — `media_extract` (delegated derivation entry, conditional-trigger),
  deterministic auto-linking (`media-links.ts`), derived retrieval via
  `media_grep`. Slicing/parallelism reuse existing Explore/Workflow primitives
  (no media-specific parallel machinery).
- **P5** — security boundary (`media-security.ts`: allowlist-based read
  permission + untrusted-content tagging, both wired into the tools and store).
  History-governance generalization and skill/memory auto-injection are Seam B
  (deferred).

## Config (control plane)

`settings.json` → `media`:

```jsonc
"media": {
  "readers": [
    { "id": "native-inline", "kind": "native" },
    { "id": "ocr", "kind": "delegated", "via": "command",
      "ref": "qwen-vl-ocr {path}", "model": "qwen-vl-ocr" }
  ],
  "decisionPolicy": { "range": "scaffold", "fps": "scaffold" },
  "injection": { "mode": "summary-first" },
  "upload": { "backend": "oss", "bucket": "my-media" }
}
```

All fields optional; unset runs native-reader-only. Swapping a reader model is a
`readers[].model` edit; flipping who owns a decision is a `decisionPolicy` edit;
neither touches core.

## Deferred (still maintainer-led / out of this slice)

1. **Active push injection at paste/drag time**: pasted/dragged media already
   enters the turn via the `@`-path (inlineData) and is governed once in history;
   a scaffold that _actively_ injects pasted media into turn assembly
   (generalizing the image push in `image-payload-references`) beyond the a/v
   eviction wired here is left to a maintainer PR.
2. **Memory (QWEN.md) media auto-injection**: memory is flattened into the
   system prompt (text), which cannot carry media parts; media paths in memory
   are pull-readable (the model can `image_view`/`media_watch` them) but are not
   auto-injected as bytes. Skill media _is_ integrated (skill results carry
   parts). Full memory auto-injection needs the text→parts pipeline change.

## Not in scope (per Q9)

Generation (image/video/TTS) — the symmetric generation track — is a separate
extension and intentionally excluded from this slice.
