package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicCommandOperation;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicCwdOperation;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellCommandOperation;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellCwdOperation;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationAdmission;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceException;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceRelativePath;
import java.util.Locale;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Autowired;

/**
 * Admits the durable close, archive and delete operations and reads them
 * back. {@link SessionLifecycleCoordinator} delivers a close or a delete.
 */
@Service
public class SessionLifecycleService {
    // The command names that archive and delete digests used before V17, so
    // a retry of an operation that V17 migrated still matches.
    private static final Map<OperationKind, String> DIGEST_NAMES = Map.of(
            OperationKind.CLOSE, "CLOSE_SESSION",
            OperationKind.ARCHIVE, "ARCHIVE_SESSION",
            OperationKind.DELETE, "DELETE_SESSION");
    private final AgentStateStore store;
    private ManagedActionService actions;

    @Autowired
    void setActions(ManagedActionService actions) {
        this.actions = actions;
    }

    private final ManagedAgentService sessions;
    private final RequestDigests digests;
    private final SessionLifecycleCoordinator coordinator;
    private RuntimeWarmer runtimeWarmer;

    @org.springframework.beans.factory.annotation.Autowired
    void setRuntimeWarmer(RuntimeWarmer runtimeWarmer) {
        this.runtimeWarmer = runtimeWarmer;
    }

    public SessionLifecycleService(AgentStateStore store,
            ManagedAgentService sessions, RequestDigests digests,
            SessionLifecycleCoordinator coordinator) {
        this.store = store;
        this.sessions = sessions;
        this.digests = digests;
        this.coordinator = coordinator;
    }

    public PublicCommandOperation admitPublic(String tenantId,
            String actorId, String idempotencyKey, String sessionId,
            OperationKind kind) {
        OperationAdmission admission = admit(tenantId, actorId,
                idempotencyKey, sessionId, kind);
        return publicOperation(admission.operation(), admission.replayed());
    }

    public WebShellCommandOperation admitWebShell(String tenantId,
            String actorId, String idempotencyKey, String sessionId,
            OperationKind kind) {
        OperationAdmission admission = admit(tenantId, actorId,
                idempotencyKey, sessionId, kind);
        return webShellOperation(admission.operation(),
                admission.replayed());
    }

    // The read-back shape is chosen by kind: a cwd change answers with its
    // own contract, every other kind with the command operation.
    public Object getPublicOperation(String tenantId, String actorId,
            String sessionId, String operationId) {
        OperationRecord operation = operation(tenantId, actorId, sessionId,
                operationId);
        return operation.kind() == OperationKind.CWD_CHANGE
                ? publicCwdOperation(operation, false)
                : publicOperation(operation, false);
    }

    public Object getWebShellOperation(String tenantId, String actorId,
            String sessionId, String operationId) {
        OperationRecord operation = operation(tenantId, actorId, sessionId,
                operationId);
        return operation.kind() == OperationKind.CWD_CHANGE
                ? webShellCwdOperation(operation, false)
                : webShellOperation(operation, false);
    }

    public PublicCwdOperation admitPublicCwdChange(String tenantId,
            String actorId, String sessionId, String idempotencyKey,
            String cwdRelative, Long expectedContextRevision) {
        OperationAdmission admission = admitCwdChange(tenantId, actorId,
                sessionId, idempotencyKey, cwdRelative,
                expectedContextRevision);
        return publicCwdOperation(admission.operation(),
                admission.replayed());
    }

    public WebShellCwdOperation admitWebShellCwdChange(String tenantId,
            String actorId, String sessionId, String idempotencyKey,
            String cwdRelative, Long expectedContextRevision) {
        OperationAdmission admission = admitCwdChange(tenantId, actorId,
                sessionId, idempotencyKey, cwdRelative,
                expectedContextRevision);
        return webShellCwdOperation(admission.operation(),
                admission.replayed());
    }

    private OperationAdmission admitCwdChange(String tenantId, String actorId,
            String sessionId, String idempotencyKey, String cwdRelative,
            Long expectedContextRevision) {
        // Actor before key, on the service itself: the published refusal
        // order must not rest on argument-evaluation order at the routes.
        if (actorId == null || actorId.isEmpty()) {
            throw new ApiException(HttpStatus.UNAUTHORIZED, "actor_required",
                    "A trusted actor is required.");
        }
        ManagedAgentService.validateIdempotencyKey(idempotencyKey);
        if (cwdRelative == null) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_request",
                    "cwd_relative is required.");
        }
        String normalized;
        try {
            normalized = WorkspaceRelativePath.normalize(cwdRelative);
        } catch (WorkspaceException error) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_cwd",
                    "The working directory is invalid.");
        }
        if (expectedContextRevision == null || expectedContextRevision < 1) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_request",
                    "expected_context_revision must be at least 1.");
        }
        String requestDigest = digests.digest(Map.of("sessionId", sessionId,
                "operation", "CWD_CHANGE", "cwdRelative", normalized,
                "expectedContextRevision",
                Long.toString(expectedContextRevision)));
        OperationAdmission admission = store.beginCwdChangeOperation(
                tenantId, sessionId, actorId, actorDigest(actorId),
                idempotencyKey, requestDigest, normalized,
                expectedContextRevision);
        OperationRecord operation = admission.operation();
        if ("PENDING".equals(operation.state())) {
            coordinator.dispatch(tenantId, sessionId,
                    operation.operationId());
        }
        return admission;
    }

    public PublicCwdOperation publicCwdOperation(OperationRecord operation,
            boolean replayed) {
        return new PublicCwdOperation(operation.operationId(),
                operation.sessionId(), "cwd_change",
                cwdStatus(operation.state()),
                operation.expectedContextRevision(),
                operation.targetCwdRelative(),
                operation.resultContextRevision(), operation.failureCode(),
                replayed);
    }

    public WebShellCwdOperation webShellCwdOperation(
            OperationRecord operation, boolean replayed) {
        return new WebShellCwdOperation(operation.operationId(),
                operation.sessionId(), "cwd_change",
                cwdStatus(operation.state()),
                operation.expectedContextRevision(),
                operation.targetCwdRelative(),
                operation.resultContextRevision(), operation.failureCode(),
                replayed);
    }

    // The store's RUNNING/FAILED states surface with the W2 contract's
    // vocabulary; terminal refusal never retries.
    private static String cwdStatus(String state) {
        return switch (state) {
            case "PENDING" -> "pending";
            case "RUNNING" -> "installing";
            case "COMPLETED" -> "completed";
            case "FAILED" -> "failed";
            default -> throw new IllegalStateException(
                    "Unknown cwd operation state " + state);
        };
    }

    private OperationAdmission admit(String tenantId, String actorId,
            String idempotencyKey, String sessionId, OperationKind kind) {
        ManagedAgentService.validateIdempotencyKey(idempotencyKey);
        SessionRecord session = store.requireSession(tenantId, sessionId);
        sessions.requireReadGrant(session, actorId);
        String digest = sessions.lifecycleDigest(sessionId, DIGEST_NAMES.get(kind));
        OperationAdmission admission;
        if (session.workspace() != null) {
            boolean activeLifecycle = "ACTIVE".equals(session.status()) && (kind == OperationKind.CLOSE || kind == OperationKind.DELETE);
            admission = store.beginWorkspaceLifecycle(tenantId, sessionId, kind, actorId, actorDigest(actorId),
                    idempotencyKey, digest, activeLifecycle ? coordinator.supportsWorkspaceLifecycle()
                            : kind == OperationKind.CLOSE && runtimeWarmer != null && runtimeWarmer.supportsWorkspaceClose(),
                    activeLifecycle ? 1 : 0);
        } else {
            sessions.requireLegacyWorkspace(tenantId, actorId, sessionId);
            admission = store.beginOperation(tenantId, sessionId, kind, actorDigest(actorId), idempotencyKey, digest);
        }
        OperationRecord operation = admission.operation();
        if (!"COMPLETED".equals(operation.state())) {
            coordinator.dispatch(tenantId, sessionId,
                    operation.operationId());
        }
        return admission;
    }

    // A deleted Session's operations stay readable, so this does not hide
    // tombstones as the Session reads do.
    private OperationRecord operation(String tenantId, String actorId,
            String sessionId, String operationId) {
        if (operationId.length() > 64) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_request",
                    "The operation id is invalid.");
        }
        SessionRecord session = store.requireSession(tenantId, sessionId);
        sessions.requireReadGrant(session, actorId);
        return store.findOperation(tenantId, sessionId, operationId)
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND,
                        "operation_not_found",
                        "The operation was not found."));
    }

    // Another actor's key is another request, so it never replays this one.
    private String actorDigest(String actorId) {
        return actorId == null ? ""
                : digests.digest(Map.of("actorId", actorId));
    }

    public PublicCommandOperation publicOperation(OperationRecord operation, boolean replayed) {
        if (operation.kind() == OperationKind.ACTION_RESPONSE) {
            return actions.publicOperation(operation, replayed);
        }
        return new PublicCommandOperation(operation.operationId(),
                operation.sessionId(), lower(operation.kind().name()),
                lower(operation.state()), lower(operation.admissionStage()),
                lower(operation.deliveryState()), operation.receiptId(),
                replayed, null, operation.failureCode());
    }

    public WebShellCommandOperation webShellOperation(OperationRecord operation, boolean replayed) {
        if (operation.kind() == OperationKind.ACTION_RESPONSE) {
            return actions.webOperation(operation, replayed);
        }
        return new WebShellCommandOperation(operation.operationId(),
                operation.sessionId(), lower(operation.kind().name()),
                lower(operation.state()), lower(operation.admissionStage()),
                lower(operation.deliveryState()), operation.receiptId(),
                replayed, null, operation.failureCode());
    }

    private static String lower(String value) {
        return value.toLowerCase(Locale.ROOT);
    }
}
