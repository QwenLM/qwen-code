# Tool-result vision bridge

## Context

The existing Vision Bridge converts images resolved from user input, while `read_file` keeps ordinary images out of text-only tool results. Other tools can return images as `inlineData`; `convertToFunctionResponse` stores those images in `functionResponse.parts`, and the request slimmer later replaces them with MIME placeholders for a text-only model. As a result, images discovered by the model or returned by built-in, MCP, and extension tools are not understood by a text-only primary model even when a vision model is configured.

## Design

`read_file` preserves an ordinary image only when the active target model is text-only and a Vision Bridge model is available. It does not call the vision model itself; PDF-specific transcription remains unchanged.

A shared core helper processes normalized tool response parts immediately before they become model input. When the active target model accepts images, or no Vision Bridge is available, the helper returns the response unchanged. If the configured vision model is agent-capable and the caller can switch the remainder of the turn, the helper clamps inline image size, preserves the tool images, and selects that model through the existing full-turn override. Otherwise, for each `functionResponse` containing inline images, it calls the existing Vision Bridge with the images and a bounded focus hint containing the tool name, image labels, and existing textual output.

The helper appends the untrusted machine transcription to the existing `response.output` or `response.error`, preserves the function name, call ID, other response fields, and non-image media, and removes every original inline image from `functionResponse.parts`. Bridge failures and cancellation replace the images with an explicit unavailable note rather than allowing raw image data to reach the text-only provider. Images over the bridge count or byte limit are also removed and reported by the transcription block.

The shared helper is used by the core tool scheduler, ACP's direct tool executor, and speculative follow-up execution. The interactive scheduler, non-interactive runner, and active ACP prompt can accept a tool-triggered full-turn override, so the next model request and later tool continuations stay on the agent-capable vision model. On surfaces that support inline model selection, the explicit selection keeps priority. Consumers without a turn-level override channel, including speculative and isolated subagent execution, reject takeover and retain the transcription fallback rather than exposing raw images to a text-only model. Built-in tools, MCP tools, and extension tools all enter through one of these paths.

Only inline image bytes are converted. Image `fileData`, URLs, path-only text, audio, and video remain outside this change because resolving them would introduce separate filesystem, network, authentication, and modality policies.

## Compatibility and failure behavior

The public tool schemas do not change. Existing user-input and PDF Vision Bridge behavior remains intact. Configurations without a vision model retain their current unsupported-image or MIME-placeholder behavior. A successful tool call is not converted into a tool error solely because the bridge fails; the model receives the original text plus a sanitized image-unavailable note. Provider error details are logged but never inserted into the function response.

## Verification

Focused tests cover ordinary image reads, nested tool images, mixed text and image results, multiple function responses, bridge failure and cancellation, multimodal-target pass-through, full-turn takeover acceptance and rejection, and preservation of function identity and non-image fields. Integration checks exercise the core scheduler, interactive and non-interactive override plumbing, ACP executor, and speculative executor call sites. Build, typecheck, bundle, and local CLI verification complete the change.
