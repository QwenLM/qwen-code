package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.contracts.session.SessionLifecycleStore;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.ApiModels.PublicCommandOperation;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellCommandOperation;
import com.alibaba.qwen.code.managedagent.model.RequestDigests;
import com.alibaba.qwen.code.managedagent.model.SessionPrincipal;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationAdmission;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore;
import org.springframework.stereotype.Service;

import java.util.Map;

/**
 * H4f of #12827: admits the public task cancel as a durable
 * {@code task_cancel} command operation. The checks run in the order the
 * task contract fixes (#12847 A6): the key, current access (404 for an
 * unreadable Session or task, then 403 {@code task_forbidden}), the
 * retained idempotency record, and only for a new request the Session
 * state, the task's {@code cancel} action and the one open operation per
 * Session — the last three atomically with the insert, under the Session
 * lock. {@link TaskCancelCoordinator} delivers the admitted operation.
 */
@Service
public class ManagedTaskCancelService {
    private final SessionLifecycleStore store;
    private final ManagedAgentService sessions;
    private final ManagedExtensionRecordStore records;
    private final RequestDigests digests;
    private final SessionLifecycleService operations;
    private final TaskCancelCoordinator coordinator;

    public ManagedTaskCancelService(SessionLifecycleStore store,
            ManagedAgentService sessions, ManagedExtensionRecordStore records,
            RequestDigests digests, SessionLifecycleService operations,
            TaskCancelCoordinator coordinator) {
        this.store = store;
        this.sessions = sessions;
        this.records = records;
        this.digests = digests;
        this.operations = operations;
        this.coordinator = coordinator;
    }

    public PublicCommandOperation cancelPublic(String tenantId,
            String actorId, String idempotencyKey, String sessionId,
            String taskId) {
        OperationAdmission admission = admit(tenantId,
                actorId,
                idempotencyKey, sessionId, taskId);
        return operations.publicOperation(admission.operation(),
                admission.replayed());
    }

    public WebShellCommandOperation cancelWebShell(String tenantId,
            String actorId, String idempotencyKey, String sessionId,
            String taskId) {
        OperationAdmission admission = admit(tenantId,
                actorId,
                idempotencyKey, sessionId, taskId);
        return operations.webShellOperation(admission.operation(),
                admission.replayed());
    }

    public PublicCommandOperation cancelPublic(SessionPrincipal principal,
            String idempotencyKey, String sessionId, String taskId) {
        OperationAdmission admission = admit(
                principal == null ? null : principal.tenantId(),
                principal, principal == null ? null : principal.userId(),
                idempotencyKey, sessionId, taskId);
        return operations.publicOperation(admission.operation(),
                admission.replayed());
    }

    public WebShellCommandOperation cancelWebShell(
            SessionPrincipal principal, String idempotencyKey,
            String sessionId, String taskId) {
        OperationAdmission admission = admit(
                principal == null ? null : principal.tenantId(),
                principal, principal == null ? null : principal.userId(),
                idempotencyKey, sessionId, taskId);
        return operations.webShellOperation(admission.operation(),
                admission.replayed());
    }

    private OperationAdmission admit(String tenantId,
            String actorId,
            String idempotencyKey, String sessionId, String taskId) {
        ManagedAgentService.validateIdempotencyKey(idempotencyKey);
        // A blank actor is the anonymous caller, matching the principal path.
        if (actorId != null && actorId.isBlank()) {
            actorId = null;
        }
        // Access is current, never replayed: a caller who lost the Session,
        // the task or the role since admission gets 404 or 403 even while
        // its operation is retained.
        SessionRecord session = sessions.requireReadableSession(tenantId,
                actorId, sessionId);
        if (records.findTask(tenantId, sessionId, taskId).isEmpty()) {
            throw new ManagedAgentException(404, "task_not_found",
                    "The task was not found.");
        }
        sessions.requireTaskCanceller(session, actorId);
        // The bound arm's digest keys on the raw actor id only, so a
        // byte-long non-ASCII actor never needs a principal here; the
        // unbound ownership digest still does.
        SessionPrincipal principal = session.workspace() != null ? null
                : principalOf(tenantId, actorId);
        String rawActor = session.workspace() != null ? actorId : null;
        return record(tenantId, session, principal, rawActor,
                idempotencyKey, sessionId, taskId);
    }

    // The trusted-boundary overload keeps its supplied principal (business
    // actor subject included); the raw-actor path above builds one only
    // after the bound-arm gates passed, so a byte-long non-ASCII actor
    // keeps cancelling a Workspace task.
    private OperationAdmission admit(String tenantId,
            SessionPrincipal principal, String actorId,
            String idempotencyKey, String sessionId, String taskId) {
        ManagedAgentService.validateIdempotencyKey(idempotencyKey);
        SessionRecord session = sessions.requireReadableSession(tenantId,
                principal, sessionId);
        if (records.findTask(tenantId, sessionId, taskId).isEmpty()) {
            throw new ManagedAgentException(404, "task_not_found",
                    "The task was not found.");
        }
        sessions.requireTaskCanceller(session, principal);
        return record(tenantId, session, principal,
                principal == null ? null : principal.userId(),
                idempotencyKey, sessionId, taskId);
    }

    private OperationAdmission record(String tenantId, SessionRecord session,
            SessionPrincipal principal, String rawActorId, String idempotencyKey,
            String sessionId, String taskId) {
        // The digest names the task and nothing trace-only, so a retry
        // carrying another request id still replays.
        String requestDigest = digests.digest(Map.of("sessionId", sessionId,
                "operation", "TASK_CANCEL", "taskId", taskId));
        String actorDigest;
        if (session.workspace() != null) {
            actorDigest = digests.digest(Map.of("actorId", rawActorId));
        } else if (principal == null) {
            // An anonymous caller admitted to a legacy no-row Session has no
            // principal identity; the cancel is scoped to the tenant-wide
            // anonymous actor — the SAME empty digest the pre-ownership code
            // stored, so rows recorded before a rolling deploy still replay
            // (R7-4). A bound Session never reaches here anonymously.
            actorDigest = "";
        } else if (!principal.actorPresent()) {
            // No business actor: keep the pre-ownership {actorId} digest so
            // idempotency rows written before this deploy still replay. The
            // tenant is already part of the operation's UNIQUE key (R7-4).
            actorDigest = digests.digest(Map.of("actorId", principal.userId()));
        } else {
            actorDigest = digests.digest(Map.of("userId", principal.userId(),
                    "actorPresent", principal.actorPresent(),
                    "actorSubjectId", principal.actorSubjectId()));
        }
        OperationAdmission admission = store.beginTaskCancelOperation(
                tenantId, sessionId, taskId, actorDigest, idempotencyKey,
                requestDigest);
        if ("PENDING".equals(admission.operation().state())) {
            coordinator.dispatch(tenantId, sessionId,
                    admission.operation().operationId());
        }
        return admission;
    }

    // An anonymous caller keeps its tenant: visibility runs before the actor
    // guard, so a foreign Session is 404 rather than actor_required.
    private static SessionPrincipal principalOf(String tenantId, String actorId) {
        return actorId == null || actorId.isBlank() ? null
                : SessionPrincipal.ofUser(tenantId, actorId);
    }
}
