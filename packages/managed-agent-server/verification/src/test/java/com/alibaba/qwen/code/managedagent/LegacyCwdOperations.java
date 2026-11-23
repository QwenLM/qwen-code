package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationAdmission;
import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentStore;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedIdentityRefs;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.UUID;

/** Seeds an operation admitted by an older deployment; it does not exercise admission. */
public final class LegacyCwdOperations {
    private LegacyCwdOperations() {}

    public static OperationAdmission seed(JdbcTemplate jdbc, ManagedAgentStore store,
            String tenant, String session, String actor, String actorDigest,
            String key, String digest, String target, long revision) {
        String id = "op_" + UUID.randomUUID().toString().replace("-", "");
        long now = System.currentTimeMillis();
        String request = JsonNodeFactory.instance.objectNode().put("schemaVersion", 1)
                .put("kind", "CWD_CHANGE").put("sessionId", session).put("targetCwdRelative", target)
                .put("expectedContextRevision", revision).toString();
        jdbc.update("INSERT INTO ma_operation (operation_ref,scope_kind,scope_id,"
                + "target_kind,target_id,phase,request_json,idempotency_digest,"
                + "tenant_id,session_id,operation_id,operation_kind,actor_digest,idempotency_key,"
                + "request_digest,state,admission_stage,delivery_state,session_status_before,"
                + "target_cwd_relative,expected_context_revision,actor_id,available_at,gmt_create,gmt_modified)"
                + " VALUES (?,'SESSION',?,'SESSION',?,'PENDING',?,?,?,?,?,'CWD_CHANGE',?,?,?,"
                + "'PENDING','JAVA_DURABLE','PENDING','ACTIVE',?,?,?,?,?,?)",
                ManagedIdentityRefs.operationRef("CWD_CHANGE", tenant, "SESSION", session, session, id),
                session, session, request, ManagedSchemaKeys.key(key),
                tenant, session, id, actorDigest, key, digest, target, revision,
                actor, now, now, now);
        return new OperationAdmission(store.findOperation(tenant, session, id).orElseThrow(), false);
    }
}
