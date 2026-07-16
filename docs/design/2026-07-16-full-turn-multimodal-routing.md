# Full-turn multimodal routing

## Context

When the primary model is text-only, Vision Bridge sends an image to a vision
model for transcription and then returns the transcription to the primary
model. That remains the safe default. Some configured vision models can also
run the complete agent loop; reducing those models to transcription loses
visual detail and prevents them from inspecting image-producing tool results.

Phase 1 adds a turn-scoped route for that explicit case. A logical turn starts
with an image-bearing user prompt and includes model retries, tool calls, tool
results, and the final assistant response. It does not include the next user
prompt.

## Routing contract

| Primary model | Selected vision model                      | Route                               | Image handling                                                  |
| ------------- | ------------------------------------------ | ----------------------------------- | --------------------------------------------------------------- |
| Image-capable | Any                                        | Existing primary route              | Send the original image directly                                |
| Text-only     | Image-capable and explicitly agent-capable | Full-turn vision route              | Send the original image and keep the logical turn on that model |
| Text-only     | Agent capability absent or false           | Existing Vision Bridge route        | Transcribe the image, then continue on the primary model        |
| Text-only     | No usable vision model                     | Existing unsupported-image behavior | Do not silently send the image to another model                 |

Direct primary routing wins over every fallback. Full-turn routing is considered
only when the current user input contains an image; plain-text turns continue
to use the primary model.

## Positive capability declaration

A model is eligible only when existing image-capability resolution succeeds and
its configuration explicitly declares:

```json
{
  "capabilities": {
    "vision": true,
    "agent": true
  }
}
```

`agent: true` is an operator promise that the selected endpoint accepts normal
agent system instructions, tool declarations, tool calls, tool results, and
multi-request continuations. It is positive-only: a missing or false value
keeps Vision Bridge behavior. Model names and provider defaults must not infer
agent capability.

## Route lifecycle

1. Resolve image support and the configured vision model before Vision Bridge
   replaces any image.
2. If the positive capability contract matches, create a request-scoped route
   containing the exact model selection and an effective configuration with
   image input enabled. This explicit projection also covers custom model names
   whose image support came from `capabilities.vision` rather than name-based
   inference.
3. Resolve that exact provider, model, and endpoint fail-closed. Provider
   identity is retained even when two providers expose the same bare model id.
   Do not fall back to the primary model or another configured model after raw
   image data is retained.
4. Use the route for the initial request, transport retries, tool-result
   continuations, and a retry of the same logical turn.
5. Keep stop hooks and blocking hook continuations on the same runtime route.
6. On successful completion or explicit abandonment, persist a media-settled
   checkpoint and release the active route. On cancellation or failure, scrub
   the live in-memory history but retain the persisted raw turn plus its exact
   route identity so retry or process restart can continue safely. A later
   independent turn settles that interrupted route before using the primary.
7. At the completed-turn boundary, replace canonical inline images with
   existing in-session
   `Image #…` references and other inline media with text placeholders. This is
   delayed until no tool continuation remains, so the routed model keeps visual
   context throughout its logical turn. Later primary models, model switches,
   follow-up suggestions, hooks, forks, summaries, and background agents never
   receive the route-scoped raw payload as historical context.

The user-facing routing notice identifies the selected model and makes clear
that the current image turn, rather than transcription alone, is handled by
that model. Routing changes only the destination and duration; it does not add
unrelated session data to the request.

## Tool runtime context

The turn route is request-scoped; it must not mutate global model configuration.
Model continuations read the locked model selection, while file and media tools
read the route's effective input modalities. Consequently, an image produced
by a tool during a full-turn vision route stays as image data for the same
model instead of being downgraded according to the text-only primary model.

Tool execution outside such a route continues to use the primary model's
runtime modalities. Phase 1 does not promote an already-running text-only turn
merely because a tool later produces an image.

## Entry-point behavior

| Entry point         | Phase 1 behavior                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TUI                 | Acquire the route for an image submit; retain it for tool results and retry; release it before the next independent user prompt.                                   |
| ACP                 | Scope the route to one `session/prompt` execution and its internal tool loop; persist exact affinity across an interrupted retry/resume.                           |
| Non-interactive CLI | Apply the same selection before the first send, retain the exact route through its tool loop and stop-hook continuations, and fail closed before any primary send. |

All entry points use the shared exact-model resolution path so a model override
cannot accidentally reuse the primary model's generator or base URL.

## Failure behavior

If the selected full-turn model cannot be resolved or its endpoint fails, the
turn reports that failure without replaying raw image content to the primary or
another fallback. A capability declaration that is absent, false, or
incompatible is not an error; it selects the existing Vision Bridge path.

## Deferred work

- **Phase 2:** persist structured, durable visual context after the routed turn
  so later text-only turns can reason from more than ordinary transcript data.
- **Phase 3:** preserve durable attachment/reference relationships across
  resume and compaction, then support explicit, on-demand reinspection of
  earlier images.

Phase 1 does not define a visual-context schema, backfill old sessions, promise
stable image identifiers, or retain raw images beyond existing history policy.
