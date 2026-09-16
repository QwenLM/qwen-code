# Web Shell Vision Bridge Notice Localization

## Problem

Vision Bridge status is emitted as an ordinary English assistant message. Web Shell receives no semantic data, so a Chinese locale cannot translate it.

## Design

Keep the English text as an ACP fallback for clients that do not understand Qwen metadata. Add a discrete `vision_bridge_notice` source with structured status, counts, model display name, endpoint, and egress state. Web Shell projects that event as a standalone system message and formats it through its existing locale catalog. Invalid or missing metadata falls back to the original text.

Within a turn, the existing processed-step control hides the notice when collapsed and restores it when expanded.

Message rewriting passes these notices through without adding them to the rewritten assistant response.

Channel bridges continue forwarding the English fallback as ordinary response text.

This change is limited to prompt-level Vision Bridge notices. TUI, headless, external ACP clients, tool-result notices, and voice notices retain their current behavior.

## Verification

- The cancelled prompt-level notice carries fallback text and structured metadata.
- The Web Shell keeps the notice separate from adjacent assistant output.
- Chinese renders localized text; malformed metadata renders the fallback.
