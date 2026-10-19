package com.alibaba.qwen.code.managedagent.store;

/**
 * The managed-event-envelope/1 contract mirrored to Java: the distribution
 * notice an EventTransport publishes after a commit — an
 * {@code authoritative_journal} fact for cross-node wake, or a
 * {@code public_event} row for materialization. The ten fields are frozen by
 * packages/core/src/managed-runtime/contracts/managed-event-envelope-v1.schema.json;
 * see {@link ManagedEventEnvelopes} for the derivation, validation and digest
 * semantics.
 */
public record ManagedEventEnvelope(int v, String sessionId, String tenantId,
        String workspaceId, String stream, long sequence, String eventId,
        String kind, long occurredAt, PayloadRef payloadRef) {
    /** The body this envelope binds, by digest only — the body never travels. */
    public record PayloadRef(String digest) {
    }
}
