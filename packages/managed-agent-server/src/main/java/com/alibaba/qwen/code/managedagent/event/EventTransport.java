package com.alibaba.qwen.code.managedagent.event;

import com.alibaba.qwen.code.managedagent.model.StoreModels.EventRecord;

import java.util.List;

/**
 * Distribution adapter behind the after-commit seam (design
 * 2026-10-04-managed-agent-event-transport, phase MQ1). Implementations carry
 * copies of committed facts to other nodes; the local SessionEventHub fan-out
 * does not depend on them. MQ1 shipped no implementation; MQ2c adds
 * LiteTopicPublicEventTransport, present only when the event transport is
 * enabled.
 *
 * <p>Implementer contract, as pinned by CompositeCommittedEventPublisher:
 * publish is invoked synchronously from the after-commit hook on the
 * committing thread — do not block. A thrown RuntimeException is logged and
 * swallowed, never retried or propagated, so delivery is best-effort; an
 * Error is not isolated and propagates. The same list instance is handed to
 * the hub and then to every transport: it is borrowed for the duration of the
 * call, so copy anything that must outlive it.
 *
 * <p>This signature deliberately mirrors CommittedEventPublisher. The two
 * ports stay separate types — an EventTransport bean must not also be a
 * CommittedEventPublisher candidate, or the store's single-publisher
 * injection would become ambiguous once an implementation exists — so a
 * change to the publication contract must be made in both files.
 */
public interface EventTransport {
    void publish(List<EventRecord> events);
}
