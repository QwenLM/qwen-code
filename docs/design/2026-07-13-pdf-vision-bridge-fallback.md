# PDF vision bridge fallback

## Context

`read_file` is text-first for PDFs when the primary model lacks native PDF support. Text extraction can still fail for scanned documents, and a single dense page can exceed the safe 12K-token tool-result budget. Returning rendered pages directly is not safe for a text-only provider, while treating every large text result as an image would make ordinary multi-page reads slower and less precise.

## Design

The file-processing layer can prepare an internal, PDF-only vision bridge candidate. This option is separate from the existing unsupported-image preservation used by interactive `@` attachments, so ordinary image reads do not change. A candidate contains rendered image parts, the trigger reason, the actual rendered page range, structured continuation metadata, and the original text-extraction error to restore if transcription cannot complete. Continuation metadata distinguishes pages known to exist from pages that may exist when page counting is unavailable.

Candidates are created only when PDF text extraction fails or when an explicit or actual single-page read still exceeds 12K estimated tokens. Multi-page text overflow, large-document page-range gates, and file-size gates retain their existing guidance. Rendering starts at the requested first page and processes at most four pages per `read_file` call. The requested range is clipped to the PDF's actual page count when known: a six-page document requested as `pages: "4-8"` renders pages 4-6 and does not invent pages 7-8. When page counting is unavailable, a short, non-byte-truncated render is treated as end-of-file; a full four-page render or byte truncation reports only that additional requested pages may exist.

`ReadFileTool` enables preparation only when the primary model is text-only and a vision bridge model is configured or available. It invokes the bridge before building the final tool response, passing only the rendered image pages plus structured PDF page context. The bridge is instructed to label transcription sections with original PDF page numbers. Continuation guidance is appended after transcription and points only to the original PDF, never to temporary rendered images.

On success, `read_file` returns untrusted, lossy machine transcription and no image data. A structured display notice discloses the selected vision model, endpoint when known, transcribed page range, and known or possible continuation. The TUI renders this notice even when successful read output is collapsed and when transcript detail is expanded; ACP, non-interactive structured output, and session exports include the same text in tool-call content rather than relying on opaque raw output. On bridge failure, empty output, timeout, or model-selection changes, the image data is discarded and the exact original PDF error is restored to the model while the bridge attempt remains visible only in the user display. User cancellation propagates. Consequently, no candidate image can reach a text-only primary provider through a tool result.

An explicitly configured `visionModel` is treated as authorization to use that model even when it is hosted by another provider. The existing bridge notice reports the actual endpoint so the data boundary remains visible.

## Compatibility

The public `read_file` schema is unchanged. Native PDF models, vision-capable primary models, configurations without a bridge model, ordinary PNG/JPEG reads, and existing interactive image behavior retain their current paths. Interactive `@` PDF resolution additionally benefits from the single-page overflow fallback.

## Verification

Unit coverage exercises requested ranges that do not begin at page 1, requests extending past the actual document end, unknown page counts, byte truncation, empty renders, single- versus multi-page overflow, bridge success and failures, cancellation, configuration changes, endpoint disclosure across TUI/ACP/export surfaces, page-number prompts, and the invariant that text-only results contain no `inlineData`. E2E verification compares the global baseline with the local build using a six-page scanned PDF, a dense single-page PDF, and a multi-page text-heavy PDF.
