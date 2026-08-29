# DingTalk dynamic lifecycle tags

## Goal

Expose agent progress on the inbound DingTalk message without changing the existing eye acknowledgement or the response-card implementation.

## Lifecycle

- Start with two tags: `👀` and `🤔 Thinking`.
- Keep `👀` fixed while replacing only the status tag.
- Map tool events to `📖 Reading`, `🔎 Searching`, `🖥️ Running`, `🛠️ Editing`, `🛠️ Working`, or `⚠️ Retrying`.
- Map response text to `✍️ Replying`.
- On a terminal event, recall both transient tags before adding exactly one of `✅ Done`, `❌ Failed`, or `⏹️ Stopped`.

Reaction operations for one inbound message are serialized so a late API response cannot restore an obsolete tag. If a status recall fails, the replacement is skipped to avoid stacking contradictory statuses.

## Delivery modes

Lifecycle tags are driven by channel lifecycle events, independently of response delivery. Plain replies, interactive status cards, and block-streaming cards therefore share the same tag behavior.

## Cleanup

Prompt cleanup, session death, and adapter disconnect recall both transient tags without adding a terminal result when the real outcome is unknown.
