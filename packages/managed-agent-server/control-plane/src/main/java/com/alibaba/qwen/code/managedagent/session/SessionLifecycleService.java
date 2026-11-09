package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore;
import com.alibaba.qwen.code.managedagent.contracts.workspace.RuntimeWarmer;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.ApiModels.PublicCommandOperation;
import com.alibaba.qwen.code.managedagent.model.ApiModels.PublicCwdOperation;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellCommandOperation;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellCwdOperation;
import com.alibaba.qwen.code.managedagent.model.RequestDigests;
import com.alibaba.qwen.code.managedagent.model.SessionPrincipal;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationAdmission;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.util.Locale;
import java.util.Map;

/**
 * Admits the durable close, archive and delete operations and reads them
 * back, with every other operation kind the shared table holds.
 * {@link SessionLifecycleCoordinator} delivers a close or a delete;
 * {@link TaskCancelCoordinator} a task cancel.
 */
@Service
public class SessionLifecycleService {
    static final String LIFECYCLE_TOOL_PROFILE = "hosted-workspace-files/1";

    // The command names that archive and delete digests used before V17, so
    // a retry of an operation that V17 migrated still matches.
    private static final Map<OperationKind, String> DIGEST_NAMES = Map.of(
            OperationKind.CLOSE, "CLOSE_SESSION",
            OperationKind.ARCHIVE, "ARCHIVE_SESSION",
            OperationKind.DELETE, "DELETE_SESSION");
    private final AgentStateStore store;
    private ManagedActionService actions;
    private ContextCompressionService compressions;

    @Autowired
    void setCompressions(ContextCompressionService compressions) {
        this.compressions = compressions;
    }

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
        OperationAdmission admission = admit(tenantId,
                principal(tenantId, actorId),
                idempotencyKey, sessionId, kind);
        return publicOperation(admission.operation(), admission.replayed());
    }

    public WebShellCommandOperation admitWebShell(String tenantId,
            String actorId, String idempotencyKey, String sessionId,
            OperationKind kind) {
        OperationAdmission admission = admit(tenantId,
                principal(tenantId, actorId),
                idempotencyKey, sessionId, kind);
        return webShellOperation(admission.operation(),
                admission.replayed());
    }

    // The tenant stays explicit so an anonymous caller keeps its legacy
    // path while a verified subject is never downgraded (R5-3).
    public PublicCommandOperation admitPublicAs(String tenantId,
            SessionPrincipal principal, String idempotencyKey,
            String sessionId, OperationKind kind) {
        OperationAdmission admission = admit(tenantId, principal,
                idempotencyKey, sessionId, kind);
        return publicOperation(admission.operation(), admission.replayed());
    }

    public PublicCommandOperation admitPublic(SessionPrincipal principal,
            String idempotencyKey, String sessionId, OperationKind kind) {
        OperationAdmission admission = admit(
                principal == null ? null : principal.tenantId(), principal,
                idempotencyKey, sessionId, kind);
        return publicOperation(admission.operation(), admission.replayed());
    }

    public WebShellCommandOperation admitWebShell(
            SessionPrincipal principal, String idempotencyKey,
            String sessionId, OperationKind kind) {
        OperationAdmission admission = admit(
                principal == null ? null : principal.tenantId(), principal,
                idempotencyKey, sessionId, kind);
        return webShellOperation(admission.operation(),
                admission.replayed());
    }

    // The read-back shape is chosen by kind: a cwd change answers with its
    // own contract, every other kind with the command operation.
    public Object getPublicOperation(String tenantId, String actorId,
            String sessionId, String operationId) {
        return getPublicOperationAs(tenantId, principal(tenantId, actorId),
                sessionId, operationId);
    }

    public Object getPublicOperation(SessionPrincipal principal,
            String sessionId, String operationId) {
        return getPublicOperationAs(principal == null ? null : principal.tenantId(),
                principal, sessionId, operationId);
    }

    // The tenant stays explicit so an anonymous caller still reads inside its
    // own tenant; the read grant admits a legacy no-row Session tenant-wide.
    public Object getPublicOperationAs(String tenantId, SessionPrincipal principal,
            String sessionId, String operationId) {
        OperationRecord operation = operation(tenantId, principal,
                sessionId, operationId);
        if (operation.kind() == OperationKind.CONTEXT_COMPRESSION) {
            return compressions.publicOperation(operation, false);
        }
        return operation.kind() == OperationKind.CWD_CHANGE
                ? publicCwdOperation(operation, false)
                : publicOperation(operation, false);
    }

    public Object getWebShellOperation(String tenantId, String actorId,
            String sessionId, String operationId) {
        return getWebShellOperation(tenantId, principal(tenantId, actorId),
                sessionId, operationId);
    }

    public Object getWebShellOperation(SessionPrincipal principal,
            String sessionId, String operationId) {
        return getWebShellOperation(principal == null ? null : principal.tenantId(),
                principal, sessionId, operationId);
    }

    private Object getWebShellOperation(String tenantId, SessionPrincipal principal,
            String sessionId, String operationId) {
        OperationRecord operation = operation(tenantId, principal,
                sessionId, operationId);
        if (operation.kind() == OperationKind.CONTEXT_COMPRESSION) {
            return compressions.webOperation(operation, false);
        }
        return operation.kind() == OperationKind.CWD_CHANGE
                ? webShellCwdOperation(operation, false)
                : webShellOperation(operation, false);
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

    static boolean usesLifecycleProtocol(SessionRecord session,
            OperationKind kind) {
        return "ACTIVE".equals(session.status())
                && (kind == OperationKind.CLOSE || kind == OperationKind.DELETE)
                && WorkspaceToolProfiles.lifecycleProtocol(session.toolProfile()) != 0;
    }

    private OperationAdmission admit(String tenantId,
            SessionPrincipal principal,
            String idempotencyKey, String sessionId, OperationKind kind) {
        String actorId = principal == null ? null : principal.userId();
        ManagedAgentService.validateIdempotencyKey(idempotencyKey);
        SessionRecord session = store.requireSession(tenantId, sessionId);
        sessions.requireReadGrant(session, principal);
        String digest = sessions.lifecycleDigest(sessionId, DIGEST_NAMES.get(kind));
        OperationAdmission admission;
        if (session.workspace() != null) {
            boolean activeLifecycle = usesLifecycleProtocol(session, kind);
            admission = store.beginWorkspaceLifecycle(tenantId, sessionId, kind, actorId, actorDigest(actorId),
                    idempotencyKey, digest, activeLifecycle ? coordinator.supportsWorkspaceLifecycle(session)
                            : kind == OperationKind.CLOSE && RuntimeWarmer.supportsClose(runtimeWarmer, session.workspace()),
                    activeLifecycle ? WorkspaceToolProfiles.lifecycleProtocol(session.toolProfile()) : 0);
        } else {
            sessions.requireLegacyWorkspace(tenantId, principal, sessionId);
            admission = store.beginOperation(tenantId, sessionId, kind,
                    principalDigest(principal), idempotencyKey, digest);
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
    private OperationRecord operation(String tenantId,
            SessionPrincipal principal,
            String sessionId, String operationId) {
        if (operationId.length() > 64) {
            throw new ManagedAgentException(400, "invalid_request",
                    "The operation id is invalid.");
        }
        SessionRecord session = store.requireSession(tenantId, sessionId);
        sessions.requireReadGrant(session, principal);
        return store.findOperation(tenantId, sessionId, operationId)
                .orElseThrow(() -> new ManagedAgentException(404,
                        "operation_not_found",
                        "The operation was not found."));
    }

    // Another actor's key is another request, so it never replays this one.
    private String actorDigest(String actorId) {
        return actorId == null ? ""
                : digests.digest(Map.of("actorId", actorId));
    }

    private static SessionPrincipal principal(String tenantId,
            String actorId) {
        return actorId == null ? null
                : SessionPrincipal.ofUser(tenantId, actorId);
    }

    private String principalDigest(SessionPrincipal principal) {
        if (principal == null) {
            // An anonymous caller admitted to a legacy no-row Session has no
            // principal identity; the operation is scoped to the tenant-wide
            // anonymous actor rather than refused. A row-present Session never
            // reaches here anonymously — its authority gate answers 404 first.
            return digests.digest(Map.of("anonymous", "legacy"));
        }
        Map<String, Object> identity = new java.util.LinkedHashMap<>();
        identity.put("tenantId", principal.tenantId());
        identity.put("userId", principal.userId());
        identity.put("actorPresent", principal.actorPresent());
        if (principal.actorPresent()) {
            identity.put("actorSubjectId", principal.actorSubjectId());
        }
        return digests.digest(identity);
    }

    public PublicCommandOperation publicOperation(OperationRecord operation, boolean replayed) {
        if (operation.kind() == OperationKind.ACTION_RESPONSE) {
            return actions.publicOperation(operation, replayed);
        }
        return new PublicCommandOperation(operation.operationId(),
                operation.sessionId(), lower(operation.kind().name()),
                lower(operation.state()), lower(operation.admissionStage()),
                lower(operation.deliveryState()), operation.receiptId(),
                replayed, null, operation.failureCode(), operation.taskId());
    }

    public WebShellCommandOperation webShellOperation(OperationRecord operation, boolean replayed) {
        if (operation.kind() == OperationKind.ACTION_RESPONSE) {
            return actions.webOperation(operation, replayed);
        }
        return new WebShellCommandOperation(operation.operationId(),
                operation.sessionId(), lower(operation.kind().name()),
                lower(operation.state()), lower(operation.admissionStage()),
                lower(operation.deliveryState()), operation.receiptId(),
                replayed, null, operation.failureCode(), operation.taskId());
    }

    private static String lower(String value) {
        return value.toLowerCase(Locale.ROOT);
    }
}
