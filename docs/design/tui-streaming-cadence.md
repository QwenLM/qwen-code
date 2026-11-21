# Terminal streaming cadence

[English](tui-streaming-cadence.md) | [简体中文](tui-streaming-cadence.zh-CN.md)

## Problem and evidence

The user sees streamed text arrive in bursts in Warp. The main chat buffers
content and reasoning for 60 ms before updating React. Ink separately limits
virtual-view rendering to 60 frames per second. The first delay therefore
groups continuously arriving small chunks before rendering can begin.

A controlled PTY reproduction sends one chunk approximately every 10 ms.
The installed CLI advances visible prose approximately every 67 ms. A separate
React and Ink experiment without the chat buffer renders ordinary Markdown
quickly enough for shorter update intervals. Code highlighting costs more and
is measured separately. These observations distinguish application batching
from provider chunk timing and terminal drawing.

At 40×16, a second reproducer keeps receiving text for over two seconds while
the visible paragraph stops progressing until completion. The pending Markdown
preview keeps only its head using the viewport's height budget. It can drop an
entire long source line, even though the virtual list can already measure and
scroll a tall row.

CI also exposed a stale viewport budget after input completion closes. Composer
locally restores its footer, increasing the controls from five rows to six,
but the parent only remeasures for an enumerated set of state changes. The
list still scrolls using 45 rows while Ink clips it to 44. This hides the last
line of `/restore` until another interaction causes measurement.

## Proposed change

Reduce the main chat's content and reasoning buffer window from 60 ms to
17 ms, approximately one 60 Hz frame. Keep the existing ordered event buffer
and boundary flushes. Consecutive text chunks still merge into one update;
thought-to-answer transitions, images, tools, completion, cancellation, and
errors retain their existing ordering. Retry replacement and model fallback
continue to discard replaced attempts.

Give pending virtual-list LLM messages the same existing large content-height
budget as committed messages. The virtual list measures the content, clips the
viewport, and follows its advancing tail. Keep the actual viewport height for
tools and approval content. LLM images also use the existing committed-message
budget and remain constrained by their content width.

Read the main controls' height through Ink's existing `useBoxMetrics` layout
subscription. This observes child-local footer, shortcut, suggestion, panel,
and dialog changes without maintaining a parent dependency list. Use the
measured height directly for the transcript budget and shell size. Retain the
existing native-scrollback reserves, tab-bar reserve, and zero-height clamp.

The shorter buffer applies to both the legacy stream processor and the shared
agent loop because they use the same event handler. It also applies to the main
chat's virtual, native-scrollback, and screen-reader presentation paths. Arena
agent tabs currently display committed round messages rather than live text;
adding streaming to those tabs is separate work.

## Decisions and scope

- Reuse the existing buffer rather than introducing another scheduler or a
  configuration setting. Ink remains responsible for limiting screen redraws.
- Preserve received text verbatim. Do not delay chunks to simulate typing or
  split a provider's large chunk into artificial character updates.
- Keep existing Markdown block boundaries, source-copy behavior, selection,
  viewport anchoring, and composer geometry. Native-scrollback previews keep
  their height safety limits; their tall-block clipping is separate from the
  virtual-list fix.
- Do not enable incremental terminal writes or introduce a Markdown/highlight
  cache in this change. Measurements must justify those separately; fewer
  output bytes alone do not establish better text cadence.

## Affected implementation

The implementation changes the buffer interval in
`packages/cli/src/ui/hooks/use-llm-stream.ts` and the pending virtual LLM height
override in `packages/cli/src/ui/components/MainContent.tsx`, with collocated
regressions. `packages/cli/src/ui/AppContainer.tsx` replaces manual controls
measurement with the existing layout hook; its tests exercise layout-only
notifications without an input or terminal-size update. No provider, protocol,
permission, or transport changes are required.

## Validation and acceptance

Use fake-timer regressions to show that content and reasoning become visible
within one buffer window, adjacent chunks remain ordered, and repeated windows
continue updating. Retain existing completion, cancellation, error, retry,
image-ordering, and shared-loop coverage.

Repeat the deterministic PTY fixture against the unchanged local bundle and
the rebuilt bundle. Record server chunk intervals and visible text progress
separately for prose, Chinese, Markdown/code, and tool-to-answer transitions.
Check final text, viewport/composer positions, and narrow terminal behavior.
For a narrow long paragraph, verify that the newest received text is visible
before completion and remains accessible by scrolling. Check pending images
and tool confirmations against their respective content/viewport budgets.
Run the repository build, typecheck, and affected unit tests.
Replay `/restore` and `/about` until history overflows, then verify the final
checkpoint name appears without a scroll/resize workaround. Run the existing
checkpoint edit, hot-restore, and cold-resume integration test. Verify the
input footer and transcript budget still agree after suggestions and shortcuts
open/close, panel changes, and narrow resizing.

Acceptance requires a materially shorter visible-update interval for steady
small prose chunks, advancing narrow virtual-list text before completion,
exact final content, and no regression in boundary flushes or layout.
A 17 ms buffer is not a promise of 60 visible frames per second:
provider bursts, render cost, and terminal scheduling still affect the result.
Native Warp/Grok frame-rate equivalence requires separate measurements.

## Open questions

None blocks this bounded change. Repeated highlighting of unchanged code and
Ink's render scheduling remain separately measurable follow-up opportunities.
