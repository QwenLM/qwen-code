# DingTalk dynamic lifecycle tags

## Goal

Expose agent progress consistently on both the inbound DingTalk message and the interactive response card without changing the card template or exposing tool details.

## Lifecycle

- Start with two tags: `👀` and `🤔 Thinking`.
- Keep `👀` fixed while replacing only the status tag.
- Map tool events to `📖 Reading`, `🔎 Searching`, `🖥️ Running`, `🛠️ Editing`, `🛠️ Working`, or `⚠️ Retrying`.
- Map response text to `✍️ Replying`.
- On a terminal event, recall both transient tags before adding exactly one of `✅ Done`, `❌ Failed`, or `⏹️ Stopped`.

Reaction operations for one inbound message are serialized so a late API response cannot restore an obsolete tag. If a status recall fails, the replacement is skipped to avoid stacking contradictory statuses.

The same lifecycle mapping drives the interactive response card's existing `statusLine`. A newly created card starts at `🤔 Thinking`; tool activity replaces that line with the mapped phase before any response text exists, and the first response chunk changes it to `✍️ Replying`. Elapsed-time refreshes preserve the current phase instead of resetting it to a generic running state. Duplicate phase events are coalesced.

Tool parameters, tool output, and model reasoning are not added to card content. The card body remains reserved for the assistant response.

## Delivery modes

Lifecycle presentation is driven by channel lifecycle events, independently of response delivery. Plain replies, interactive status cards, and block-streaming cards therefore share the same inbound-message tag behavior. Interactive cards also project the current phase into `statusLine`; block streaming does not create a status card and continues to rely on the inbound-message tags for progress.

Reaction failures and status-card metadata failures are isolated from each other and from response delivery.

## Cleanup

Prompt cleanup, session death, and adapter disconnect recall both transient tags without adding a terminal result when the real outcome is unknown.
