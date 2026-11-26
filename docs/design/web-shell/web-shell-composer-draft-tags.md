# Restoring Web Shell draft tags

[English](web-shell-composer-draft-tags.md) | [简体中文](web-shell-composer-draft-tags.zh-CN.md)

## Problem

The desktop composer uses inline chips to display serialized references embedded in a draft. When the page reloads, Web Shell restores the draft text and any saved file chips. Host-defined chips lose their positions and show their serialized text.

## Design

Reuse the host's `parseUserMessageContent` to reconstruct inline chips. The parser must account for the entire source text exactly. Infer each chip's range from the lengths of the parser's parts and reject empty ranges.

For a desktop composer with a host parser, extend the existing draft envelope with an optional array of inline ranges. Save the ranges known to the editor, including an empty array when it has no host chips. Persist host chip positions only. The parser recreates each recognized chip at its exact recorded range, so identical text typed elsewhere stays editable. Chip metadata is reconstructed at restore time.

Older drafts lack the range array. Recover references the parser recognizes at positions outside existing structured file chips. File chips keep their saved positions and metadata. If the parser cannot reconstruct a chip, its source remains editable. Open composers sharing a draft continue to use the positions from the live editor.

This change covers the desktop inline composer. The touch textarea continues using its existing draft behavior.

## Acceptance criteria

- Insert two host chips among surrounding text, reload, and verify both return at their original positions. Remove one chip and reload again. The remaining chip retains its position, and only its reference is annotated on submit.
- Type the same serialized reference as ordinary text and insert it separately as a chip. After reload, only the inserted reference appears as a chip.
- Open a legacy draft with host references and a saved file chip. Recognized host references recover without overlapping the file chip. A missing parser or output that changes the source leaves the host text editable.
- Switch between two sessions with separate drafts and verify their chip positions follow the active draft.
