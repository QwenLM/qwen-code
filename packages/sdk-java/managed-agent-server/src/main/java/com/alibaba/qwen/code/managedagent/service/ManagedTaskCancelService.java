package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.ApiModels.PublicCommandOperation;
import com.alibaba.qwen.code.managedagent.api.ApiModels.WebShellCommandOperation;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecordStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationAdmission;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

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
    private final AgentStateStore store;
    private final ManagedAgentService sessions;
    private final ManagedExtensionRecordStore records;
    private final RequestDigests digests;
    private final SessionLifecycleService operations;
    private final TaskCancelCoordinator coordinator;

    public ManagedTaskCancelService(AgentStateStore store,
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
        OperationAdmission admission = admit(tenantId, actorId,
                idempotencyKey, sessionId, taskId);
        return operations.publicOperation(admission.operation(),
                admission.replayed());
    }

    public WebShellCommandOperation cancelWebShell(String tenantId,
            String actorId, String idempotencyKey, String sessionId,
            String taskId) {
        OperationAdmission admission = admit(tenantId, actorId,
                idempotencyKey, sessionId, taskId);
        return operations.webShellOperation(admission.operation(),
                admission.replayed());
    }

    private OperationAdmission admit(String tenantId, String actorId,
            String idempotencyKey, String sessionId, String taskId) {
        ManagedAgentService.validateIdempotencyKey(idempotencyKey);
        // Access is current, never replayed: a caller who lost the Session,
        // the task or the role since admission gets 404 or 403 even while
        // its operation is retained.
        SessionRecord session = sessions.requireReadableSession(tenantId,
                actorId, sessionId);
        if (records.findTask(tenantId, sessionId, taskId).isEmpty()) {
            throw new ApiException(HttpStatus.NOT_FOUND, "task_not_found",
                    "The task was not found.");
        }
        sessions.requireTaskCanceller(session, actorId);
        // The digest names the task and nothing trace-only, so a retry
        // carrying another request id still replays.
        String requestDigest = digests.digest(Map.of("sessionId", sessionId,
                "operation", "TASK_CANCEL", "taskId", taskId));
        String actorDigest = actorId == null ? ""
                : digests.digest(Map.of("actorId", actorId));
        OperationAdmission admission = store.beginTaskCancelOperation(
                tenantId, sessionId, taskId, actorDigest, idempotencyKey,
                requestDigest);
        if ("PENDING".equals(admission.operation().state())) {
            coordinator.dispatch(tenantId, sessionId,
                    admission.operation().operationId());
        }
        return admission;
    }
}
