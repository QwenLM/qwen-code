# Web Shell transcript layout during replay

[English](2026-11-19-web-shell-replay-layout.md) | [简体中文](2026-11-19-web-shell-replay-layout.zh-CN.md)

## Problem

A full transcript replay can mount many virtual rows with Markdown tables in a single commit. Row refs synchronously measure uncached heights, and each newly mounted enhanced table sets its scroll position. The browser can repeat layout after each DOM change and delay input even after the composer has restored focus. In a local production build, a key took 1.71 seconds to reach the editor DOM during replay of a recorded conversation.

## Changes

- Set the message list's virtual overscan to 15 rows. Keep the enhanced table renderer and the existing threshold for virtualization.
- When following the latest messages, use cached or estimated heights on the initial virtual row ref. Use ResizeObserver to obtain the real size. Keep normal measurement when reading history, restoring a prepended page, locating a message, or running without ResizeObserver.
- Restore an enhanced table's scroll position on mount when a fullscreen transition has saved it. A new table already starts at the initial position.

## Verification

Replay the same recorded transcript with the production build. Dispatch keys during the longest frame while the editor is focused and editable. Verify that all those keys reach the DOM and the slowest takes less than 700 ms. Check fast scrolling, loading an older page with its viewport anchor preserved, search navigation, and the enhanced table's fullscreen scroll and focus restoration.
