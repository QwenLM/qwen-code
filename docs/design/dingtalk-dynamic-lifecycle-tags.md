# DingTalk dynamic lifecycle tags

## Goal

Expose agent progress consistently on both the inbound DingTalk message and the interactive response card without changing the card template or exposing tool details.

## Lifecycle

- Start with two tags: `👀` and `🤔 Thinking`.
- Keep `👀` fixed while replacing only the status tag.
- Map tool events to `📖 Reading`, `🔎 Searching`, `🖥️ Running`, `🛠️ Editing`, `🛠️ Working`, or `⚠️ Retrying`.
- Map response text to `✍️ Replying`.
- On a terminal event, recall both transient tags before adding exactly one of `✅ Done`, `❌ Failed`, or `⏹️ Stopped`.

Reaction operations for one inbound message use a desired-state drain. A newer phase overwrites any pending phase, and a terminal event preempts every phase that has not reached DingTalk yet. An already in-flight API request cannot be cancelled, so the drain re-reads desired state after each response and removes any obsolete tag before settling. If a status recall fails, the replacement is skipped to avoid stacking contradictory statuses.

The same lifecycle mapping drives a replaceable first line in the interactive response card body. A newly created card starts at `🤔 Thinking`; tool activity replaces that line with the mapped phase before any response text exists, and the first response chunk changes it to `✍️ Replying`. While a response streams, its content appears below that phase line. Duplicate phase events are coalesced.

The running card's `statusLine` contains only the configured model and elapsed time. On completion, the process line is removed from the body so only the final assistant response remains; the existing terminal state, model, and elapsed time stay in `statusLine`. Tool titles, descriptions, paths, commands, parameters, output, and model reasoning are never added to lifecycle events or card content.

Phase and terminal labels use the effective Qwen display language after environment override, configured-language selection, and `auto` system-language detection. Presentation language never changes the agent prompt or tool-call schema.

When named-task attribution supplies a source label, the escaped source label stays above the phase and response content throughout running, streaming, fallback, and terminal card states.

## Delivery modes

Lifecycle presentation is driven by channel lifecycle events, independently of response delivery. Plain replies, interactive status cards, and block-streaming cards therefore share the same inbound-message tag behavior. Interactive cards also project the current phase into the body; block streaming does not create a status card and continues to rely on the inbound-message tags for progress.

Reaction failures and status-card metadata failures are isolated from each other and from response delivery.

## Cleanup

Prompt cleanup, session death, and adapter disconnect recall both transient tags without adding a terminal result when the real outcome is unknown.
