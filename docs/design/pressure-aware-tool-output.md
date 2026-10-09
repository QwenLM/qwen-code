# Pressure-aware tool output

[English](pressure-aware-tool-output.md) | [简体中文](pressure-aware-tool-output.zh-CN.md)

## Problem

Issue #2566: in a long session whose context is filling up, tool results keep the same static budget, so a few large results can push the conversation over the compaction trigger faster than it needs to. Token counts are owned by a chat and its provider route, so a shared Config getter cannot pick a dynamic budget; the decision has to be made where a chat sends its request.

## Change

At the chat send boundary, a chat may shrink the tool results of the request it is about to send, using only its own last successful usage report. That report anchors the decision only when it came from the same provider route, nothing has replaced the counts or history since, and the history it covered is still an unchanged prefix of the current history. A restored or estimated count, a replaced history, a different route, another chat, or any request dispatched after the report means no anchor and the static budgets apply unchanged. An explicit `truncateToolOutputThreshold` always wins.

The headroom is measured against the auto-compaction trigger, not the hard ceiling: remaining tokens = (auto − reported prompt+output tokens − conservatively estimated new input the budget cannot shorten) / the existing new-content safety factor. On the default 1M window the band between auto (850k) and hard (977k) is about 127k tokens, so a hard-ceiling anchor only shrank results after compaction had already been triggered. The character budget is remaining tokens × 4, rounded down, and applies only when it is below the batch's static capacity — the per-tool threshold times the number of results the budget can shorten. This budget takes precedence over preview size: there is no 4,000-character minimum, and positive headroom below one character produces empty preview text. At or above the auto trigger there is no headroom to share and compaction owns the situation, so nothing is shrunk.

The budget is shared by all tool results in the request and applied in the same single pass as the existing 200k aggregate send guard, taking the tighter of the two, so a result is never cut twice. An aggregate budget configured `<= 0` keeps its non-finite "disabled" sentinel and turns that whole pass off, exactly as it does on every other consumer of the setting; an adaptive zero budget instead empties the budgeted tool text. User text in the same message is never shortened. Before shortening a result, this pass uses the existing finalizer persistence path to save its complete budgeted text to a unique send-boundary artifact. The preview keeps the head and tail when they fit and includes the recovery path within its character budget. A very small preview can shorten or omit that pointer, but the saved original remains in the session tool-results directory. Existing disk size, session budget and write-failure limits still apply; persistence is best effort. User text and exempt output are excluded from both shrinking and new persistence. Protected plan lifecycle text is charged to headroom before allocation. A shortened read-file result disarms its quote-back cache entry without revoking prior-read rights; shortening shell output does not clear file reads.

## Scope and limits

The static defaults stay at 25,000 characters / 1,000 lines; this change does not raise them. Only the character budget adapts; the line cap is unchanged. Because the band starts close to the auto trigger, the budget only bites in roughly the last few thousand tokens before auto-compaction: below that point it is larger than the batch's static capacity, and above it compaction runs. The cap covers the text slots the send guard can shorten, including its truncation notice; response framing, media, exempt output and protected lifecycle text retain their existing treatment. This is a complement to compaction, not a replacement, and it does not guarantee exact token admission.

Result-size accounting (#11536) is a separate change.

## Acceptance

Focused tests cover: shrinking near the auto trigger on a 1M window; parallel and media-bearing previews below 4,000 characters; a small-window send below auto; an empty preview for sub-character positive headroom; preserved manual budget disabling, user text and exempt output; original output persisted before pressure shrinking; no change far from or past auto; static output for explicit, estimated, restored, foreign-route and other-chat ownership; and no reuse of a report once a later request was dispatched.
