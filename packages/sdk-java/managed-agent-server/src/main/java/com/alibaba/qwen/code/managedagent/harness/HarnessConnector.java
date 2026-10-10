package com.alibaba.qwen.code.managedagent.harness;

import com.alibaba.qwen.code.daemon.HarnessRuntimeRecovery;
import java.util.List;
import java.util.Map;
import com.fasterxml.jackson.databind.JsonNode;

public interface HarnessConnector extends AutoCloseable {
    boolean isAvailable();

    default boolean isWorkspaceFilesAvailable() {
        return false;
    }

    default boolean supportsLifecycle() { return false; }

    default JsonNode settleLifecycle(com.alibaba.qwen.code.managedagent.store.StoreModels.OperationRecord operation) {
        throw new UnsupportedOperationException("Hosted lifecycle is unavailable");
    }

    default void detachLifecycle(com.alibaba.qwen.code.managedagent.store.StoreModels.OperationRecord operation) {
        throw new UnsupportedOperationException("Hosted lifecycle is unavailable");
    }

    Attachment createOrLoad(String tenantId, String sessionId,
            boolean loadExisting);

    default Attachment createOrLoad(String tenantId, String sessionId,
            boolean loadExisting, boolean passiveManagedRuntimeRecovery) {
        return createOrLoad(tenantId, sessionId, loadExisting);
    }

    /**
     * Loads a previously attached Session for a Turn takeover, settling or
     * reporting its parked Runtime executions. A plain cold load must stay
     * inert, so only this path may touch the Broker for a parked Turn.
     */
    default Attachment recoverManagedRuntime(String tenantId, String sessionId,
            boolean cancellation) {
        throw new UnsupportedOperationException(
                "Managed Runtime recovery is unavailable");
    }

    /**
     * Sends the cancellation takeover load even when this Harness already
     * serves the Session: a plain cancel the daemon refused with
     * {@code hosted_turn_recovery_required} is payable only by that load,
     * while the healthy-attachment shortcut would answer from cache and
     * never tell the daemon (R9-P1-2).
     */
    default Attachment recoverManagedCancellation(String tenantId,
            String sessionId) {
        throw new UnsupportedOperationException(
                "Managed Runtime recovery is unavailable");
    }

    Admission submit(String tenantId, String sessionId, String promptId,
            List<Map<String, Object>> input, String payloadDigest);

    default Admission continueManagedRuntime(String tenantId,
            String sessionId, String promptId, String checkpointId,
            String activationId) {
        throw new UnsupportedOperationException(
                "Managed Runtime continuation is unavailable");
    }

    default Admission cancelManagedRuntime(String tenantId, String sessionId,
            String promptId, String checkpointId, String activationId) {
        throw new UnsupportedOperationException(
                "Managed Runtime cancellation is unavailable");
    }

    SourceStream stream(String tenantId, String sessionId, long lastEventId,
            String eventEpoch);

    default void resolveAction(
            String tenantId,
            String sessionId,
            String actionId,
            JsonNode response) {
        throw new UnsupportedOperationException("Hosted Actions are unavailable");
    }

    void cancel(String tenantId, String sessionId);

    /**
     * H6b/H6c: one automation operation onto the Session's journal, from the
     * control plane's automation service and scanner (define_schedule,
     * retire_schedule, fire_run). The Hosted side settles it before
     * answering, and the answer carries the operation's result.
     */
    default Map<String, Object> runAutomationOperation(String tenantId,
            String sessionId, Map<String, Object> body) {
        throw new UnsupportedOperationException(
                "Automation operations are unavailable");
    }

    /**
     * H4b: one child operation onto the Session's journal, from the
     * control plane's relay (dispatch/attach/result/accept/cancel/
     * close-scope). The Hosted side settles it before answering.
     */
    default void runChildOperation(String tenantId, String sessionId,
            Map<String, Object> body) {
        throw new UnsupportedOperationException(
                "Child operations are unavailable");
    }

    /**
     * H4d-b: one session message operation onto the Session's journal,
     * from the control plane's message relay (handover, receive, accepted,
     * consumed, cancelled, rejected, unknown, consume), and the child
     * result relay's stop of a stopped run's message turns (stop). The
     * Hosted side settles it before answering. A receive or consume starts
     * work in the Session, so it takes the same Workspace admission as a
     * submit.
     */
    default void runMessageOperation(String tenantId, String sessionId,
            Map<String, Object> body) {
        throw new UnsupportedOperationException(
                "Message operations are unavailable");
    }

    /**
     * H5b/H5c: one channel operation onto the Session's journal, from the
     * control plane's channel service (submit_input, claim_delivery,
     * segment_receipt, settle_delivery, cancel_delivery, resend_delivery).
     * The Hosted side settles it before answering, and the answer carries
     * the operation's result.
     */
    default Map<String, Object> runChannelOperation(String tenantId,
            String sessionId, Map<String, Object> body) {
        throw new UnsupportedOperationException(
                "Channel operations are unavailable");
    }

    void rename(String tenantId, String sessionId, String title);

    /**
     * Closes the Session and returns the boot ID of the Harness that
     * answered. A Harness that does not hold the Session answers too.
     */
    String closeSession(String tenantId, String sessionId);

    @Override
    default void close() {
    }

    record Attachment(String bootId, HarnessRuntimeRecovery runtimeRecovery,
            Long lastEventId, String eventEpoch) {
        public Attachment(String bootId) {
            this(bootId, null, null, null);
        }

        public Attachment(String bootId,
                HarnessRuntimeRecovery runtimeRecovery) {
            this(bootId, runtimeRecovery, null, null);
        }
    }

    record Admission(long lastEventId, String eventEpoch) {
    }

    record SourceEvent(Long id, String type, Object data, String promptId,
            Map<String, Object> metadata) {
    }

    interface SourceStream extends AutoCloseable {
        String eventEpoch();

        SourceEvent next();

        @Override
        void close();
    }
}
