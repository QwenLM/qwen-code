# Offline daemon listener occupancy

[English](2026-11-21-daemon-offline-occupancy.md) | [简体中文](2026-11-21-daemon-offline-occupancy.zh-CN.md)

## Problem

`qwen daemon status` reads a local discovery record, then probes the daemon over HTTP. Its detail command also fetches the daemon status endpoint. An operator diagnosing listener pressure needs to see how many long-lived connections hold slots even when an HTTP request cannot get through. [Issue #18004](https://github.com/QwenLM/qwen-code/issues/18004)

## Command and output

`qwen daemon status --offline` reads discovery records and their local occupancy snapshots. It skips health probes and reports health as `unchecked`, or `stale` when the recorded process is gone in the reader's addressable PID namespace. It rejects `--detail` and `--prune` because those options have live or mutating behavior.

The text view shows the total, per-surface and per-listener counts, and the sample's `asOf` time. `--offline --json` includes the same values in `streamOccupancy` with a `stale` flag. A sample is stale if it is at least 15 seconds old, appears to be from the future, or its local process is known to be gone. An unavailable, unreadable or invalid sample is displayed as unavailable (`null` in JSON). Across PID namespaces, health remains `unchecked`. The `stale` flag reflects only the timestamp of the sample associated with the matching discovery record, and daemon liveness remains unknown.

## Publication and lifetime

After writing its discovery record, the daemon publishes a versioned companion file in the same private directory. The file name binds the sample to the discovery record's port, PID, start time and PID namespace. The file contains the timestamp and the existing process-wide occupancy counters, including WebSockets that hold listener slots.

The publisher samples immediately and then every five seconds. It uses an asynchronous same-directory temporary file with mode `0600` and atomic rename. The timer is unreferenced and skips a tick when a write is pending. Write failures leave the last readable sample in place. The daemon's shutdown lifecycle stops the timer, waits for any pending publication, and removes the file, including when the listener closes directly or the daemon restarts for an update. A crash can leave the record and the last sample on disk. Pruning or stopping the daemon through its matching discovery record also removes its companion. A daemon on a reused port reads and writes through its own discovery identity.

## Scope and verification

This work covers the local daemon discovery and command paths. The occupancy counters come from the same source as the existing HTTP status surface. Admission and connection recovery are tracked in [#17479](https://github.com/QwenLM/qwen-code/issues/17479).

- Observe the count rise and fall through the bundled CLI as a real local stream opens and closes. Verify that offline text and JSON readings report the corresponding counts and sample time.
- Use a loopback server that records socket accepts and HTTP requests. Both totals stay at zero for offline status. A regular status read reaches `/health`.
- Check stale and missing samples, port reuse, pruning, and graceful shutdown cleanup. A reader sees a complete previous or new sample during a refresh.
- Check that incompatible flags fail before probing or pruning and that a failing snapshot write leaves the daemon available.
