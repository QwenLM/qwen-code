# Pressure-aware tool output

[English](pressure-aware-tool-output.md) | [简体中文](pressure-aware-tool-output.zh-CN.md)

## Problem

Issue #2566: in a long session whose context is filling up, tool results keep the same static budget, so a few large results can push the conversation over the compaction trigger faster than it needs to. Token counts are owned by a chat and its provider route, so a shared Config getter cannot pick a dynamic budget; the decision has to be made where a chat sends its request.

## Change

At the chat send boundary, a chat may shrink the tool results of the request it is about to send, using only its own last successful usage report. That report anchors the decision only when it came from the same provider route, nothing has replaced the counts or history since, and the history it covered is still an unchanged prefix of the current history. A restored or estimated count, a replaced history, a different route, another chat, or any request dispatched after the report means no anchor and the static budgets apply unchanged. An explicit `truncateToolOutputThreshold` always wins.

The headroom is measured against the auto-compaction trigger, not the hard ceiling: remaining tokens = (auto − reported prompt+output tokens − conservatively estimated new input the budget cannot shorten) / the existing new-content safety factor. On the default 1M window the band between auto (850k) and hard (977k) is about 127k tokens, so a hard-ceiling anchor only shrank results after compaction had already been triggered. The character budget is remaining tokens × 4, floored at 4,000 characters per result in the batch, and applies only when it is below the batch's static capacity — the per-tool threshold times the number of results the budget can shorten. At or above the auto trigger there is no headroom to share and compaction owns the situation, so nothing is shrunk.

The budget is shared by all tool results in the request, taking the tighter of it and the existing 200k aggregate send guard. Before applying that candidate, the send boundary checks the actual estimate used by compaction. If the candidate still reaches auto, it selects the aggregate-only candidate instead, provided that candidate stays below hard. This avoids discarding result text when compaction will run anyway. In a small window where the aggregate-only request would reach hard, the pressure cut remains necessary even if it still triggers compaction. Both candidates are derived from the original results, so a result is never cut twice.

An aggregate budget configured `<= 0` keeps its non-finite "disabled" sentinel and turns the whole send guard off, exactly as it does on every other consumer of the setting. User text in the same message is never shortened. Like the existing send guard, the selected candidate keeps the head and tail of each result and does not write a new spill file; results that were already spilled by the per-tool layer keep their recovery pointer.

## Scope and limits

The static defaults stay at 25,000 characters / 1,000 lines; this change does not raise them. Only the character budget adapts; the line cap is unchanged. Because the band starts close to the auto trigger, the budget only bites in roughly the last few thousand tokens before auto-compaction: below that point it is larger than the batch's static capacity, and above it compaction runs. This is a complement to compaction, not a replacement, and it does not guarantee exact token admission.

Result-size accounting (#11536) is a separate change.

## Acceptance

Focused tests cover: shrinking near the auto trigger on a 1M window; preserving eight full results when the per-result floor still admits the real compaction gate; preserving media alongside text in that same floor band; retaining the floor when a small-window aggregate-only request would reach hard; no change far from or past auto; one shared budget across parallel results with user text preserved; static output for explicit, estimated, restored, foreign-route and other-chat ownership; and no reuse of a report once a later request was dispatched. The real-gate regression stops at a controlled PreCompact hook before summary generation; actual CLI requests and completion are verified separately with a controlled provider and tmux capture.
