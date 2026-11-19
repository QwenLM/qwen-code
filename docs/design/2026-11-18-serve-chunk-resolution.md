# Index bundled startup chunks

[English](2026-11-18-serve-chunk-resolution.md) | [简体中文](2026-11-18-serve-chunk-resolution.zh-CN.md)

## Problem

Starting the packaged daemon and its first ACP child resolves many exact relative imports between generated ESM chunks. Moving imports across the listener reduces the time to listen while most of this work remains on the path to a usable workspace.

## Design

For packaged serve and ACP entry paths, index regular esbuild chunks from the installed chunk directory once. On Node versions with synchronous resolution hooks, use a lookup for exact relative imports from the packaged entry and the indexed chunks. Return the same file URL and let Node load and cache the module. Delegate other specifiers, custom loaders, and unpackaged entry layouts to Node's regular resolver.

## Verification

Build the baseline and candidate from the same source baseline and use the same Node executable and single CPU in the pre-release Linux sandbox. Alternate cold process starts using a fresh runtime, a primary workspace and six restored registrations. Measure deep health and the target root stat, then create a session and send a prompt to the same loopback model fixture. The gate is at least a 30% reduction in workspace readiness P50. Check first-session and first-prompt P50/P95, workspace ownership, persisted sessions and first-probe shutdown cancellation.
