package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.session.AgentStateStore;
import com.alibaba.qwen.code.managedagent.workspace.WorkspaceToolProfiles;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeExtensionCommandVerifier;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.alibaba.qwen.code.runtimebroker.transport.ManagedExtensionCommandProtocol;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.codec.digest.DigestUtils;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;
import java.util.Set;

/** Reads command permissions from the committed journal, never from caller-supplied approval data. */
@Component
public final class ManagedExtensionCommandVerifier implements RuntimeExtensionCommandVerifier {
    private final JdbcTemplate jdbc;
    private final ManagedExtensionRecordStore records;
    private final AgentStateStore sessions;
    private final ObjectMapper json;

    public ManagedExtensionCommandVerifier(@Qualifier("managedJdbcTemplate") JdbcTemplate jdbc, ManagedExtensionRecordStore records, AgentStateStore sessions, @Qualifier("managedAgentObjectMapper") ObjectMapper json) {
        this.jdbc = jdbc;
        this.records = records;
        this.sessions = sessions;
        this.json = json;
    }

    @Override
    public void verify(RuntimeBindingRecord runtime, RuntimeSession session, Map<String, Object> operation) {
        ManagedExtensionCommandProtocol.validateSession(session, operation);
        try {
            verifyCommitted(runtime, session, json.valueToTree(operation));
        } catch (ManagedExtensionRecords.InvalidRecordException | ManagedAgentException error) {
            throw denied();
        }
    }

    private void verifyCommitted(RuntimeBindingRecord runtime, RuntimeSession session, JsonNode operation) {
        String tenant = session.getScope().getTenantId();
        String harness = session.getHarnessSessionId();
        String stageId = operation.get("operationId").textValue();
        JsonNode grant = operation.get("grant");
        ManagedExtensionRecords.requireOperationGrant(grant);
        long now = jdbc.queryForObject("SELECT " + ManagedSchemaTime.SQL_NOW, Long.class);
        check(grant.get("expiresAt").longValue() > now);
        check(java.util.stream.StreamSupport.stream(grant.get("resourceScope").get("phases").spliterator(), false)
                .anyMatch(phase -> phase.equals(operation.get("action"))));
        JsonNode recordRef = grant.get("resourceScope").get("recordRef");
        var projection = jdbc.query("SELECT revision, record_resource_id, operation_hash FROM ma_session_record"
                        + " WHERE record_kind='DOMAIN' AND session_scope_key=? AND tenant_id=? AND workspace_id=?"
                        + " AND session_id=? AND domain='tool_stage' AND record_id=?",
                (row, index) -> new Projection(row.getLong(1), row.getString(2), row.getString(3)),
                ManagedSessionStore.sessionScopeKey(tenant, harness), tenant, session.getScope().getWorkspaceId(), harness, stageId);
        check(projection.size() == 1);
        Projection latest = projection.getFirst();
        check(latest.revision() == grant.get("operationRevision").longValue()
                && latest.resourceId().equals(recordRef.get("resourceId").textValue())
                && latest.operationHash().equals(DigestUtils.sha256Hex(grant.get("operationId").textValue())));
        JsonNode stage = records.readRecordResource(tenant, harness, recordRef);
        ManagedToolStageRecords.requireStage(stage);
        check(stageId.equals(stage.get("toolStageId").textValue()) && operation.get("toolName").equals(stage.get("toolName")));
        JsonNode run = stage.get("run");
        check(runtime.getBindingId().equals(run.path("runtime").path("runtimeBindingId").asText())
                && Long.toString(runtime.getGeneration()).equals(run.path("runtime").path("generation").asText()));
        JsonNode inputRef = stage.get("inputRef");
        check("managed-extension-command-input".equals(inputRef.get("kind").textValue()) && inputRef.get("schemaVersion").asInt() == 1);
        JsonNode input = records.readRecordResource(tenant, harness, inputRef);
        check(input.isObject() && ManagedExtensionRecords.same(input, operation.get("input")));
        JsonNode permissionRef = stage.get("permissionRef");
        check(!permissionRef.isNull() && "managed-extension-command-permission".equals(permissionRef.get("kind").textValue())
                && permissionRef.get("schemaVersion").asInt() == 1);
        JsonNode permission = records.readRecordResource(tenant, harness, permissionRef);
        ManagedExtensionRecords.closed(permission, Set.of("allowed", "toolName", "inputRef", "approvalMode",
                "preHookOccurrence", "permissionHookOccurrence", "actionRequestId"), "Command permission");
        check(permission.get("allowed").isBoolean() && permission.get("allowed").booleanValue()
                && permission.get("toolName").equals(stage.get("toolName"))
                && ManagedExtensionRecords.same(inputRef, permission.get("inputRef"))
                && WorkspaceToolProfiles.supportsApprovalMode(permission.path("approvalMode").asText()));
        for (String field : List.of("preHookOccurrence", "permissionHookOccurrence", "actionRequestId")) {
            if (!permission.get(field).isNull()) {
                ManagedExtensionRecords.id(permission.get(field), field);
            }
        }
        // Recovery reads only this committed stage and its original owner, including while configuration admission is closed.
        if ("execute".equals(operation.get("action").textValue())) {
            var owner = sessions.requireSession(tenant, harness);
            var approval = jdbc.queryForList("SELECT COALESCE(selected_approval_mode, approval_mode) FROM ma_session"
                    + " WHERE tenant_id=? AND session_id=?", String.class, tenant, harness);
            check(owner.workspace() != null && owner.workspace().getWorkspaceId().equals(session.getScope().getWorkspaceId())
                    && approval.size() == 1 && approval.getFirst().equals(permission.get("approvalMode").textValue())
                    && (!"shell".equals(stage.get("toolName").textValue()) || WorkspaceToolProfiles.isPublicShell(owner.toolProfile())));
            check("running".equals(run.get("state").textValue()) && "dispatch_started".equals(run.get("execution").textValue()));
            ManagedConfigInstall.requireOpen(jdbc, tenant, harness);
            JsonNode configuration = ManagedMcpSettings.find(jdbc, tenant, harness);
            for (int step = 0; ManagedConfigInstall.isPackageConfig(configuration)
                    && !"active".equals(configuration.path("phase").asText()); step++) {
                check(step < 4096 && !configuration.path("previousRecordRef").isNull());
                configuration = records.readRecordResource(tenant, harness, configuration.get("previousRecordRef"));
            }
            check(ManagedConfigInstall.isPackageConfig(configuration) && "active".equals(configuration.path("phase").asText())
                    && configuration.get("configRevision").equals(operation.get("revision")));
            JsonNode bundle = records.readRecordResource(tenant, harness, configuration.get("bundleRef"));
            check("managed-extension-config-bundle".equals(bundle.path("kind").asText())
                    && bundle.path("formatVersion").asInt() == 1 && bundle.get("configRevision").equals(operation.get("revision"))
                    && bundle.path("packages").isArray()
                    && java.util.stream.StreamSupport.stream(bundle.get("packages").spliterator(), false)
                    .anyMatch(entry -> operation.get("extensionId").equals(entry.path("pin").get("extensionId"))));
        }
    }

    private record Projection(long revision, String resourceId, String operationHash) { }

    private static void check(boolean condition) {
        if (!condition) {
            throw denied();
        }
    }

    private static RuntimeBrokerException denied() {
        return new RuntimeBrokerException(403, "extension_command_permission_invalid", "The committed extension command permission is invalid or stale.", false);
    }
}
