package com.alibaba.qwen.code.managedagent.store;

/**
 * The authoritative-journal wire (design 2026-10-04-managed-agent-event-transport,
 * phase MQ2b). An after-commit publication point on {@link ManagedSessionStore#commit}
 * hands the committed journal record (the raw record bytes) to this port. It is
 * distinct from the {@link EventTransport} hub seam, which carries the public
 * event stream that MQ2c wires as the {@code public_event} envelope extension.
 *
 * <p>Implementer contract: invoked synchronously from the after-commit hook on
 * the committing thread, so an implementation must not block; and a publication
 * failure must be logged and swallowed, never propagated — it surfaces only as a
 * wake/materialization delay, because consumers reconcile against SQL and never
 * treat the broker as recovery evidence (the #12380 constraint).
 */
public interface JournalEventTransport {
    void publishCommitted(byte[] recordBytes);
}
