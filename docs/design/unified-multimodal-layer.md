# Unified Multimodal Layer (media)

Status: initial skeleton (P0–P5 additive slice) landed on `feat/unified-multimodal-layer`.

This implements the skeleton + minimal working defaults of the unified
multimodal understanding layer described in the omni_harness design docs
(`需求与设计-统一多模态理解.md`, `方案-统一多模态层与媒体记忆.md`,
`实施计划.md`). It follows the three beliefs: cross-session media memory,
"assumptions expire → pluggable", and "one interface + config selects the
implementation + an effort knob". Everything here is **additive** — no
core hotspot (`geminiChat`, `coreToolScheduler` media pass-through,
`converter.ts`) changed behavior; media reaches the model over the existing
tool-result media path.

## Layers and seams

```
tools/media/*            L1 orchestration (image_view, media_watch, media_grep, media_extract)
utils/media/*            L2 provider-agnostic core (Seam A: reader registry, probe, policy, C10)
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

## Deferred (Seam B — maintainer-led, touches core hotspots)

1. **Push injection**: scaffold actively injecting pasted/dragged media into
   turn assembly (`geminiChat`), generalizing the existing image push code.
2. **History/compression governance for audio/video**: eviction alignment,
   duplicate-injection guards, model-switch rebuild (`chatCompressionService`,
   `image-payload-references`).
3. **skill/memory media auto-injection**: pull-style additive loading is
   enabled today (the model can `image_view`/`media_watch` any referenced path);
   automatic injection at load time is the Seam B side and is deferred.

## Not in scope (per Q9)

Generation (image/video/TTS) — the symmetric generation track — is a separate
extension and intentionally excluded from this slice.
