package com.alibaba.qwen.code.managedagent.contracts.session;

import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellSessionOptions;
import com.alibaba.qwen.code.managedagent.model.SessionModelConfig;
import com.alibaba.qwen.code.managedagent.model.SessionPrincipal;
import com.alibaba.qwen.code.managedagent.model.StoreModels;
import com.alibaba.qwen.code.managedagent.model.StoreModels.Admission;
import com.alibaba.qwen.code.managedagent.model.StoreModels.CommandRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionMutationCommand;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionMutationKind;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.fasterxml.jackson.databind.JsonNode;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Session, Turn and command admission: creation, idempotent replay,
 * mutations and rename delivery.
 */
public interface SessionAdmissionStore {
    public default Admission insertSessionCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String agentId,
            String requestedRevision, String title,
            List<Map<String, Object>> input, String payloadDigest) {
        return insertSessionCommand(tenantId, (String) null, operation,
                idempotencyKey, requestDigest, agentId, requestedRevision,
                title, input, payloadDigest);
    }

    public Admission insertSessionCommand(String tenantId, String actorId,
            String operation, String idempotencyKey, String requestDigest,
            String agentId, String requestedRevision, String title,
            List<Map<String, Object>> input, String payloadDigest);

    public default Admission insertSessionCommand(String tenantId, String actorId,
            String operation, String idempotencyKey, String requestDigest,
            String agentId, String requestedRevision, String title,
            List<Map<String, Object>> input, String payloadDigest,
            SessionModelConfig modelConfig) {
        if (modelConfig != null) {
            throw new UnsupportedOperationException("Session model configuration is unavailable");
        }
        return insertSessionCommand(tenantId, actorId, operation, idempotencyKey,
                requestDigest, agentId, requestedRevision, title, input, payloadDigest);
    }

    public default Admission insertSessionCommand(String tenantId, String actorId,
            String operation, String idempotencyKey, String requestDigest,
            String agentId, String requestedRevision, String title,
            List<Map<String, Object>> input, String payloadDigest,
            com.alibaba.qwen.code.managedagent.model.SessionModelConfig modelConfig, String memoryStoreId) {
        if (memoryStoreId != null) {
            throw new UnsupportedOperationException("Session memory is unavailable");
        }
        return insertSessionCommand(tenantId, actorId, operation, idempotencyKey,
                requestDigest, agentId, requestedRevision, title, input, payloadDigest, modelConfig);
    }

    /**
     * Ownership-enforcing creation of a non-Workspace Session. The
     * implementation must write the ownership row in the same transaction
     * as the Session, receipt and creation event.
     */
    public default Admission insertSessionCommand(String tenantId,
            SessionPrincipal principal, String operation,
            String idempotencyKey, String requestDigest, String agentId,
            String requestedRevision, String title,
            List<Map<String, Object>> input, String payloadDigest) {
        throw new UnsupportedOperationException(
                "Session ownership records are unavailable");
    }

    /**
     * The ownership-enforcing creation with a model configuration. The
     * default fails closed on a non-null configuration, exactly like the
     * actor-carrying twin; the principal-only path keeps its own refusal.
     */
    public default Admission insertSessionCommand(String tenantId,
            SessionPrincipal principal, String operation,
            String idempotencyKey, String requestDigest, String agentId,
            String requestedRevision, String title,
            List<Map<String, Object>> input, String payloadDigest,
            com.alibaba.qwen.code.managedagent.model.SessionModelConfig modelConfig) {
        if (modelConfig != null) {
            throw new UnsupportedOperationException("Session model configuration is unavailable");
        }
        return insertSessionCommand(tenantId, principal, operation, idempotencyKey,
                requestDigest, agentId, requestedRevision, title, input, payloadDigest);
    }

    /**
     * The ownership-enforcing creation that also binds a memory store. The
     * default fails closed on a non-null store, exactly like the
     * actor-carrying twin.
     */
    public default Admission insertSessionCommand(String tenantId,
            SessionPrincipal principal, String operation,
            String idempotencyKey, String requestDigest, String agentId,
            String requestedRevision, String title,
            List<Map<String, Object>> input, String payloadDigest,
            com.alibaba.qwen.code.managedagent.model.SessionModelConfig modelConfig,
            String memoryStoreId) {
        if (memoryStoreId != null) {
            throw new UnsupportedOperationException("Session memory is unavailable");
        }
        return insertSessionCommand(tenantId, principal, operation, idempotencyKey,
                requestDigest, agentId, requestedRevision, title, input, payloadDigest,
                modelConfig);
    }

    /** Requires that {@code principal} owns an unbound Session exactly. */
    public default void requireSessionOwnership(String tenantId,
            String sessionId, SessionPrincipal principal) {
        throw new UnsupportedOperationException(
                "Session ownership checks are unavailable");
    }

    /** The read-only twin of {@link #requireSessionOwnership}. */
    public default boolean ownsSession(String tenantId, String sessionId,
            SessionPrincipal principal) {
        throw new UnsupportedOperationException(
                "Session ownership checks are unavailable");
    }

    /**
     * The unified write authority over an unbound Session; identical to
     * {@link #requireSessionReadAuthority}. A present ownership row is the sole
     * authority; a legacy Session without a row has no per-actor mutation gate
     * and stays tenant-wide.
     */
    public default void requireSessionAuthority(String tenantId,
            String sessionId, SessionPrincipal principal) {
        throw new UnsupportedOperationException(
                "Session ownership checks are unavailable");
    }

    /**
     * The unified read authority over an unbound Session: a present ownership
     * row is the sole authority; a legacy Session without a row stays
     * tenant-wide readable.
     */
    public default void requireSessionReadAuthority(String tenantId,
            String sessionId, SessionPrincipal principal) {
        throw new UnsupportedOperationException(
                "Session ownership checks are unavailable");
    }

    /**
     * The raw-actor twin of {@link #requireSessionReadAuthority}: the caller is
     * the filter-admitted actor string, so no byte-bounded principal is built
     * for a legacy Session that has no ownership row to match (R7-1).
     */
    public default void requireSessionReadAuthority(String tenantId,
            String sessionId, String actorId) {
        throw new UnsupportedOperationException(
                "Session ownership checks are unavailable");
    }

    /**
     * H4b: creates a child Session under its parent's exact binding,
     * stamping the lineage in the same transaction. The idempotency key
     * derives from the parent's committed launch, so a replay returns the
     * original admission and never mints a second Session. The caller is
     * the control plane (the relay), so this path deliberately skips the
     * public actor/workspace checks — the parent's row carries them.
     */
    public default StoreModels.Admission insertChildSessionCommand(String tenantId,
            String parentSessionId, String idempotencyKey,
            String requestDigest, String title, List<Map<String, Object>> input,
            String payloadDigest, StoreModels.SessionLineage lineage) {
        throw new UnsupportedOperationException("Child Session creation is unavailable");
    }

    public default StoreModels.Admission insertPublicChildSessionCommand(String tenantId,
            String parentSessionId, String idempotencyKey, String requestDigest,
            String title, List<Map<String, Object>> input, String payloadDigest,
            StoreModels.SessionLineage lineage, JsonNode snapshot) {
        throw new UnsupportedOperationException("Public child Session creation is unavailable");
    }

    /**
     * The isolation slice (#13753 I1): the same creation, bound to the
     * child run's ready child Workspace. The child's row takes the
     * Workspace's directory instead of the parent's; the creating
     * transaction locks the Workspace row and refuses unless it is ready,
     * unfinished, prepared from the parent's current Workspace and storage,
     * and names {@code childCwdRelative}.
     */
    public default StoreModels.Admission insertChildSessionCommand(String tenantId,
            String parentSessionId, String idempotencyKey,
            String requestDigest, String title, List<Map<String, Object>> input,
            String payloadDigest, StoreModels.SessionLineage lineage,
            String childCwdRelative) {
        throw new UnsupportedOperationException("Child Session creation is unavailable");
    }

    /**
     * The child directory a child run's Workspace recorded, or null before
     * its layout was recorded. Readiness is the creating transaction's to
     * check, so a replay still answers once the Workspace moved on.
     */
    public default String findChildWorkspaceCwd(String tenantId,
            String parentSessionId, String childRunId) {
        return null;
    }

    /** The replay of {@link #insertChildSessionCommand}: same key and
     * digest answers the original admission; either mismatch conflicts. */
    public default StoreModels.Admission replayChildSessionCommand(String tenantId,
            String parentSessionId, String idempotencyKey,
            String requestDigest) {
        throw new UnsupportedOperationException("Child Session creation is unavailable");
    }

    /** A child Session's persisted lineage, or null for a root Session. */
    public default StoreModels.SessionLineage findChildLineage(String tenantId,
            String sessionId) {
        return null;
    }

    /**
     * Creates a Workspace-bound Session from one named command. The
     * default fails closed: an implementation that has not opted into
     * workspace creation refuses it wholesale rather than silently
     * accepting a capability it cannot honor.
     */
    public default Admission insertWorkspaceSessionCommand(SessionCreationCommand command) {
        throw new UnsupportedOperationException("Workspace session creation is unavailable");
    }

    public Optional<Admission> findWorkspaceCreateReplay(String tenantId,
            String actorId, String idempotencyKey, String requestDigest);

    public default WebShellSessionOptions workspaceSessionOptions(
            String tenantId, String agentId) {
        throw new UnsupportedOperationException("Approval mode selection is unavailable");
    }

    public Admission replayWorkspaceSessionCommand(String tenantId, String actorId,
            String idempotencyKey, String requestDigest);

    public Admission insertTurnCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String sessionId,
            List<Map<String, Object>> input, String payloadDigest);

    /**
     * The actor-carrying variant records the caller on the command receipt,
     * so the receipt's replay answers the actor who recorded it — an
     * OPERATOR's own retry of his own key — and not only the creator. The
     * default drops the actor for implementations that cannot record it.
     */
    public default Admission insertTurnCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String sessionId,
            List<Map<String, Object>> input, String payloadDigest,
            String actorId) {
        return insertTurnCommand(tenantId, operation, idempotencyKey,
                requestDigest, sessionId, input, payloadDigest);
    }

    /** The principal-carrying Turn admission for an unbound Session. */
    public default Admission insertTurnCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String sessionId,
            List<Map<String, Object>> input, String payloadDigest,
            SessionPrincipal principal) {
        throw new UnsupportedOperationException(
                "Principal-scoped Turn commands are unavailable");
    }

    public Admission insertCancelCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String sessionId,
            String turnId);

    /** The actor-carrying twin of {@link #insertTurnCommand}. */
    public default Admission insertCancelCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String sessionId,
            String turnId, String actorId) {
        return insertCancelCommand(tenantId, operation, idempotencyKey,
                requestDigest, sessionId, turnId);
    }

    /** The principal-carrying twin of the Turn admission. */
    public default Admission insertCancelCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String sessionId,
            String turnId, SessionPrincipal principal) {
        throw new UnsupportedOperationException(
                "Principal-scoped cancel commands are unavailable");
    }

    public SessionMutationCommand beginSessionMutation(String tenantId,
            String operation, String idempotencyKey, String requestDigest,
            String sessionId, SessionMutationKind kind);

    /** The actor-carrying twin of {@link #insertTurnCommand}. */
    public default SessionMutationCommand beginSessionMutation(String tenantId,
            String operation, String idempotencyKey, String requestDigest,
            String sessionId, SessionMutationKind kind, String actorId) {
        return beginSessionMutation(tenantId, operation, idempotencyKey,
                requestDigest, sessionId, kind);
    }

    public default SessionMutationCommand beginSessionMutation(String tenantId,
            String operation, String idempotencyKey, String requestDigest,
            String sessionId, SessionMutationKind kind, String actorId,
            SessionPrincipal principal) {
        throw new UnsupportedOperationException(
                "Principal-scoped Session mutations are unavailable");
    }

    public SessionMutationCommand beginSessionRename(String tenantId, String idempotencyKey,
            String requestDigest, String sessionId, String title);

    /** The actor-carrying twin: the recorded rename answers its recorder. */
    public default SessionMutationCommand beginSessionRename(String tenantId,
            String idempotencyKey, String requestDigest, String sessionId,
            String title, String actorId) {
        return beginSessionRename(tenantId, idempotencyKey, requestDigest,
                sessionId, title);
    }

    public default SessionMutationCommand beginSessionRename(String tenantId,
            String idempotencyKey, String requestDigest, String sessionId,
            String title, String actorId, SessionPrincipal principal) {
        throw new UnsupportedOperationException(
                "Principal-scoped Session renames are unavailable");
    }

    public SessionRecord completeSessionRename(String tenantId, String idempotencyKey,
            String sessionId, String title, String harnessBootId, long revision);

    public SessionRecord completeSessionRename(StoreModels.RenameDelivery delivery, String owner, String bootId);

    public void abandonSessionRename(String tenantId, String idempotencyKey,
            String sessionId, long revision, String owner);

    public List<StoreModels.RenameDelivery> deliverableRenames(long now);

    public Optional<StoreModels.RenameDelivery> claimRename(StoreModels.RenameDelivery delivery,
            String owner, Duration lease);

    public void markRenameSubmitted(StoreModels.RenameDelivery delivery, String owner);

    public void retryRename(StoreModels.RenameDelivery delivery, String owner, long availableAt);

    public SessionRecord completeSessionMutation(String tenantId, String operation,
            String idempotencyKey, String sessionId,
            SessionMutationKind kind, String title, String harnessBootId);

    /**
     * Retires the command row of a Session mutation the Harness refused
     * before completion, so the refusal does not leave the Session's
     * later lifecycle changes blocked by a {@code PENDING} row nothing
     * completes. The receipt and digest survive for same-content retries
     * and concurrent completion; completed outcomes remain replayable.
     */
    public void abandonSessionMutation(String tenantId, String operation,
            String idempotencyKey, String sessionId);

    public Admission replayCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest);

    public Optional<CommandRecord> findCommand(String tenantId, String operation,
            String idempotencyKey);
}
