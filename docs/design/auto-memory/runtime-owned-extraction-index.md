# Generate automatic memory indexes from saved entries

[English](runtime-owned-extraction-index.md) | [简体中文](runtime-owned-extraction-index.zh-CN.md)

## Problem

The background extraction agent is instructed to write each topic file and then edit its `MEMORY.md` index. The runtime already generates indexes from the saved topics. Index edits can consume several tool turns, especially when an edit fails and the model retries.

## Design

The extractor starts with the topic list and opens existing files as needed to avoid duplicates. It writes topics inside the existing user and project roots and leaves the root indexes to the runtime. The extraction permissions allow reading those indexes and deny writes, including through a symlink. The rule applies to the two exact index paths. Other memory operations use their existing permissions.

The runtime rebuilds the affected indexes from successful write receipts, including when the fork reports cancellation or a turn limit. If the fork rejects without returning receipts, the runtime attempts to reconcile both roots before reporting the error. A failed project rebuild records pending work without moving the history offset. The next extraction repairs the index before starting a model call, even if a retry would have no new topic writes. User-index repair is best effort. The scheduler, history window and model selection continue to use their existing settings.

## Verification

Use a scripted provider to cover a new topic, an update, a read-only check, a denied index write and a failure after a completed topic write. Inspect both topic files and the generated indexes. Verify that an index rebuild failure leaves the history offset in place and that the next run can repair it with no new writes.

Compare the base and candidate on five paired runs per fixed real-model scenario with identical initial memory and conversation inputs. Include new facts, updates and turns without a durable fact. Report model calls per batch, index write attempts and failures, provider input and cached tokens, elapsed time and fresh-session recall. The update samples must reproduce index maintenance on the base. Target zero model index writes, at least one fewer request at the median of paired update samples, and all required facts recallable in the correct scope.
