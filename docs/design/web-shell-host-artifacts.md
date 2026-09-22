# WebShell host artifact integration

[English](web-shell-host-artifacts.md) | [简体中文](web-shell-host-artifacts.zh-CN.md)

## Problem and scope

Hosts currently replace all right-panel opens. Artifact cards cannot be filtered without changing session data, and external preview renderers cannot reuse the internal code highlighter. This change provides general host contracts without product routing, storage mutations, or new preview UI.

## Contracts

`onRightPanelOpen` returns false to continue native handling. True or undefined retains existing host ownership; missing callbacks use native handling. The ownership decision is synchronous: legacy async handlers remain host-owned without awaiting their Promise. Callback exceptions do not cause a second open. Existing file-review override precedence stays unchanged.
An optional `filterArtifact` predicate receives the artifact and source session/turn context. Apply it only to displayed turn outputs before collapsed counts, including split panes. Session artifact synchronization and file-change classification retain original records. Without a predicate, existing rendering is unchanged.
Expose a framework-independent asynchronous code-highlighting function through the package public API, backed by the existing singleton, language loading and size policy. Input is code, language and light/dark theme; output is highlighted HTML or null for plain-text fallback. Do not expose the mutable Shiki instance. Library consumers own their renderer and styles. Separate JavaScript realms have separate instances.

## Files and limits

The existing customization context carries the display filter to primary, split, and nested transcripts. ChatPane and MessageList forward the source session identity. The public `./code-highlighter` entry and chat entry share the same module within one JavaScript realm; preview-only consumers do not import chat UI or its stylesheet. The existing codeHighlighter implements the service; no new engine, grammar set, theme set or backend routes. Public README and focused colocated tests document behavior.

## Validation

Verify absent/void/true/false callbacks and native subagent fallback; filtered artifact counts in main/split messages without data loss; light/dark highlighting, unknown language and oversized input fallback. Build library and declarations, run package tests and final upstream preflight. Verify host layouts and unchanged standalone behavior with real browser evidence. Status: implementation in progress; real-browser and upstream gates pending.
