package com.alibaba.qwen.code.managedagent.repository;

import java.util.List;

public interface SessionMessageRelayStore {
    public static final int MAX_ATTEMPTS = 64;

    public static final String LEDGER_OWES_WORK = "(l.delivery_id IS NULL"
            + " OR (l.transport_state NOT IN ('done', 'orphaned', 'unknown')"
            + " AND l.attempt_count < " + MAX_ATTEMPTS + "))";

    public record PendingMessage(String tenantId, String senderSessionId,
            String messageId, String domain, String deliveryState,
            String recordResourceId) {
    }

    public record MessageRow(String tenantId, String senderSessionId,
            String messageId, String targetSessionId, String state,
            String claimedBy, long claimedUntil, int attempts,
            long nextRetryAt, String lastError, long claimGeneration) {
        public MessageRow(String tenantId, String senderSessionId, String messageId, String targetSessionId,
                String state, String claimedBy, long claimedUntil, int attempts, long nextRetryAt, String lastError) {
            this(tenantId, senderSessionId, messageId, targetSessionId, state, claimedBy, claimedUntil,
                    attempts, nextRetryAt, lastError, 0);
        }
    }

    public record Lineage(String parentSessionId, String parentChildRunId) {
    }

    public record CurrentRecord(String deliveryState,
            String recordResourceId) {
    }

    public List<PendingMessage> findPendingMessages(String workerId, long now,
            int limit);

    public CurrentRecord currentRecord(String tenantId, String sessionId,
            String domain, String messageId);

    public String deliveryState(String tenantId, String sessionId,
            String domain, String messageId);

    public Lineage lineage(String tenantId, String sessionId);

    public boolean olderOpenCommand(String tenantId, String senderSessionId,
            String commandId);

    public List<String> olderOwedMessages(String tenantId,
            String senderSessionId, String messageId);

    public MessageRow claim(String tenantId, String senderSessionId,
            String messageId, String owner, long leaseUntil, long now);

    public MessageRow find(String tenantId, String senderSessionId, String messageId);

    public void advance(MessageRow row, String owner, String state, String targetSessionId,
            long nextRetryAt, long leaseUntil, long now);

    public void scheduleRetry(MessageRow row, String owner, long nextRetryAt, long leaseUntil, long now);

    public void defer(MessageRow row, String owner, long nextRetryAt, String lastError, long leaseUntil, long now);

    public void classify(MessageRow row, String owner, String state, String lastError, long now);
}
