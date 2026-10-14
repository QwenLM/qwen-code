package com.alibaba.qwen.code.managedagent.store;

/**
 * The managed-event-envelope/1 contract mirrored to Java: the distribution
 * notice an EventTransport publishes after a Session Authority commit, for
 * cross-node wake on journal facts. The ten fields are frozen by
 * packages/core/src/managed-runtime/contracts/managed-event-envelope-v1.schema.json;
 * see {@link ManagedEventEnvelopes} for the derivation, validation and digest
 * semantics. Declared, not enabled — no runtime path produces one in MQ2a.
 */
public record ManagedEventEnvelope(int v, String sessionId, String tenantId,
        String workspaceId, String stream, long sequence, String eventId,
        String kind, long occurredAt, PayloadRef payloadRef) {
    /** The body this envelope binds, by digest only — the body never travels. */
    public record PayloadRef(String digest) {
    }
}
