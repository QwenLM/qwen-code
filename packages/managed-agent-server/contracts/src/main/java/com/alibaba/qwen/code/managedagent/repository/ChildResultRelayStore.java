package com.alibaba.qwen.code.managedagent.repository;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.List;
import java.util.Set;

public interface ChildResultRelayStore {
    public record PendingChild(String tenantId, String parentSessionId,
            String childRunId, long revision, String deliveryState,
            String recordResourceId) {
    }

    public record RelayRow(String tenantId, String parentSessionId,
            String childRunId, String creationKey, String childSessionId,
            String state, String claimedBy, long claimedUntil, int attempts,
            long nextRetryAt, String lastError, long createdAt,
            long updatedAt, long claimGeneration, String operationKind) {
        public RelayRow(String tenantId, String parentSessionId, String childRunId, String creationKey,
                String childSessionId, String state, String claimedBy, long claimedUntil, int attempts,
                long nextRetryAt, String lastError, long createdAt, long updatedAt) {
            this(tenantId, parentSessionId, childRunId, creationKey, childSessionId, state, claimedBy,
                    claimedUntil, attempts, nextRetryAt, lastError, createdAt, updatedAt, 0, "CHILD_SESSION_START");
        }
    }

    public record TurnLine(String turnId, String status, Long completedAt,
            String errorCode, boolean submissionAttempted,
            String harnessEventEpoch) {
        /** Whether this Turn proves a dispatch went out — the same pair
         * the G3 submission machinery guards with. */
        public boolean dispatched() {
            return submissionAttempted || harnessEventEpoch != null;
        }

        /** Whether this Turn is the terminal pre-admission failure: an
         * undispatched, terminally failed (or cancelled) admission. A
         * live enqueued ACCEPTED Turn shares `!dispatched()` with it —
         * only the terminal half may ever settle a never-started
         * verdict (R24's runnable-Turn guard). */
        public boolean preAdmissionTerminal() {
            return ("FAILED".equals(status) || "CANCELLED".equals(status))
                    && !dispatched();
        }
    }

    public List<PendingChild> findPendingChildren(String workerId, int limit);

    public List<PendingChild> findPendingChildren(String workerId, long now,
            int limit);

    public String deliveryState(String tenantId, String parentSessionId,
            String childRunId);

    public String executionState(String tenantId, String parentSessionId,
            String childRunId);

    public record StopState(boolean stopRequested, boolean ended) {
    }

    public StopState stopState(String tenantId, String parentSessionId,
            String childRunId);

    public boolean turnCancelRequested(String tenantId, String sessionId,
            String turnId);

    public String readResource(String tenantId, String sessionId, String resourceId);

    public byte[] readResourceBytes(String tenantId, String sessionId, String resourceId);

    public String readResource(String tenantId, String resourceId);

    public byte[] readResourceBytes(String tenantId, String resourceId);

    public record SettledTurn(String turnId, String outcome, String source,
            long settledAt) {
    }

    public record JournalTurns(int pendingMessageInputs,
            Set<String> messageInputs, long lastActivityAt,
            SettledTurn lastSettled) {
    }

    public record EdgeMessages(int undelivered, int toChild,
            List<String> receivedToChild) {
    }

    public EdgeMessages edgeMessages(String tenantId, String parentSessionId,
            String childRunId, String childSessionId);

    public boolean childOwesHandover(String tenantId, String childSessionId);

    public boolean hasSessionMessages(String tenantId, String sessionId);

    public JournalTurns journalTurns(String tenantId, String sessionId);

    public String journalTurnText(String tenantId, String sessionId,
            String turnId);

    public JsonNode childRunBody(String tenantId, String parentSessionId,
            String childRunId);

    public record LiveScope(String childRunId, String recordResourceId) {
    }

    public List<LiveScope> findLiveScopes(String tenantId,
            String parentSessionId);

    public boolean hasAcceptance(String tenantId, String sessionId,
            String childRunId);

    public String sessionStatus(String tenantId, String sessionId);

    public TurnLine latestTurn(String tenantId, String sessionId);

    public TurnLine firstTurn(String tenantId, String sessionId);

    public String terminalResultText(String tenantId, String sessionId,
            String turnId);

    public RelayRow claim(String tenantId, String parentSessionId, String childRunId, String creationKey,
            String owner, long leaseUntil, long now);

    public RelayRow find(String tenantId, String parentSessionId, String childRunId);

    public String findLineageChild(String tenantId, String parentSessionId,
            String childRunId);

    public void advance(RelayRow row, String owner, String state, String childSessionId, long nextRetryAt,
            String lastError, long leaseUntil, long now);

    public void retainCloseDebt(RelayRow row, String owner, String classification, String childSessionId,
            long nextRetryAt, String lastError, long leaseUntil, long now);

    public void scheduleRetry(RelayRow row, String owner, long nextRetryAt, long leaseUntil, long now);

    public void defer(RelayRow row, String owner, long nextRetryAt, String lastError, long leaseUntil, long now);

    public void classify(RelayRow row, String owner, String state, String lastError, long now);
}
