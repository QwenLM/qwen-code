# Background agent status and details

## Problem

An Agent tool call returns as soon as a background agent is launched. Its transcript block therefore has a terminal tool event whose payload says `status: background`. The Web Shell intentionally maps that launch result back to a pending tool card, but nothing later reconciles the card with the live background-task registry. The footer task list reaches a terminal state while the original Agent card remains running.

Foreground agents already open in the shared subagent detail panel. Background agents have the same `toolUseId`, task registry entry, JSONL transcript, and virtual-session resolver, but this path lacks explicit coverage.

## Design

Keep the launch projection unchanged: a launch result with `status: background` remains pending until authoritative task state arrives. The daemon already emits terminal background-agent notifications over the session SSE stream with the task `status` and `toolUseId`. The Web Shell consumes that hidden notification metadata and reconciles it back into the projected Agent tool card.

- `completed` and `cancelled` complete the card.
- `failed` fails the card.
- The notification timestamp becomes the card end time.
- Notifications without `toolUseId`, non-agent notifications, and unrelated tool calls do not directly change messages.

The existing subagent detail provider remains the only UI path. Background Agent cards stay clickable while pending and after terminal reconciliation. The virtual-session resolver continues to stream the task JSONL and obtain live status from the task registry without filtering on foreground/background mode. For legacy tasks without `toolUseId`, it matches the launch record to the persisted sidecar and keeps a terminal sidecar status when the original background launch result still says `running`.

While detached work is active, its main-list card uses a dedicated static `background task` label instead of the foreground `running` label. The card does not use the running shimmer or a ticking elapsed timer. Terminal notifications replace that label with the normal completed, failed, or cancelled presentation.

Background agents are omitted from the bottom status bar because their progress is available from the clickable card and detail panel. They remain in the full Tasks panel. Other background task kinds, including shell commands, remain in the bottom status bar and retain their existing polling. A background Agent by itself does not activate bottom-bar task polling.

Persisted notification records do not always retain a `toolUseId`. When a loaded transcript contains an active background Agent card, the Web Shell therefore resolves each pending card through the existing subagent endpoint after transcript catch-up. It repeats this one-shot check after a reconnect and when any terminal Agent notification arrives, even if that notification cannot identify the card directly. It never starts an interval. Input focus and ordinary streaming do not change the pending Agent call IDs or terminal-notification key and therefore do not trigger another request.

The docked detail panel expands from the right edge so the chat is pushed left continuously instead of resizing before a separate panel motion. Reduced-motion preferences disable the docked animation. Panel tabs keep a fixed width, truncate long titles, and scroll horizontally when the tab list exceeds the available space.

## Scope

This change updates the Web Shell projection and the daemon's virtual-subagent status resolver. It does not rewrite persisted parent transcripts, alter the task lifecycle, add task polling for background agents, remove agents from the full Tasks panel, or add a second subagent viewer.
