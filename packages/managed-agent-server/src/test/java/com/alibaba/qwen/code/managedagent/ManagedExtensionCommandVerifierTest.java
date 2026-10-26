package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.persistence.ManagedExtensionCommandVerifier;
import com.alibaba.qwen.code.managedagent.persistence.ManagedExtensionProjection;
import com.alibaba.qwen.code.managedagent.persistence.ManagedExtensionRecordStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.session.AgentStateStore;
import com.alibaba.qwen.code.managedagent.workspace.WorkspaceToolProfiles;
import com.alibaba.qwen.code.runtimebroker.ManagedExtensionExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.commons.codec.digest.DigestUtils;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.io.IOException;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class ManagedExtensionCommandVerifierTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String EXTENSION = "ext_550e8400-e29b-41d4-a716-446655440001";
    private static final RuntimeScope SCOPE = new RuntimeScope("tenant", "workspace", "1", "/workspace",
            ManagedExtensionExecutionProfile.DEVELOPER_CAPABILITY_DIGEST, "session");
    private final RuntimeSession session = new RuntimeSession("harness", "runtime", "bootstrap", SCOPE);
    private final RuntimeBindingRecord runtime = new RuntimeBindingRecord("binding", new RuntimeProvisionRequest(SCOPE, "harness"), 1,
            RuntimeBindingRecord.State.READY, new RuntimeLease("worker", URI.create("http://127.0.0.1:9"), "token", "lease", 1),
            false, null, null, 0, 0, Instant.now(), Instant.now());
    private JdbcTemplate jdbc;
    private ManagedExtensionCommandVerifier verifier;
    private ObjectNode stage;
    private ObjectNode grant;
    private ObjectNode operation;
    private ObjectNode activeConfig;
    private ObjectNode activeConfigRef;

    @BeforeEach
    void setup() throws IOException {
        var source = new DriverManagerDataSource("jdbc:h2:mem:command-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "");
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        jdbc.update("INSERT INTO ma_session (tenant_id, session_id, agent_id, status, approval_mode, gmt_create, gmt_modified)"
                + " VALUES ('tenant', 'harness', 'agent', 'ACTIVE', 'default', 0, 0)");
        jdbc.update("UPDATE ma_session SET selected_approval_mode='yolo', approval_revision=1"
                + " WHERE tenant_id=? AND session_id=?", "tenant".getBytes(java.nio.charset.StandardCharsets.UTF_8),
                "harness".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        var sessions = mock(AgentStateStore.class);
        when(sessions.requireSession("tenant", "harness")).thenReturn(new SessionRecord("tenant", "harness", "agent", null, "Session",
                "READY", null, null, 0, 0, 0, 0, 0, null, 0,
                new ContextBinding("tenant", "workspace", 1, "storage", ".", "config", 1), "default", WorkspaceToolProfiles.SHELL));
        verifier = new ManagedExtensionCommandVerifier(jdbc, new ManagedExtensionRecordStore(jdbc), sessions, JSON);
        ObjectNode input = JSON.createObjectNode().put("command", "pwd").put("description", "cwd");
        ObjectNode inputRef = resource("managed-extension-command-input", input);
        ObjectNode permission = JSON.createObjectNode().put("allowed", true).put("toolName", "shell").put("approvalMode", "yolo")
                .putNull("preHookOccurrence").putNull("permissionHookOccurrence").putNull("actionRequestId");
        permission.set("inputRef", inputRef);
        stage = (ObjectNode) fixtures("managed-tool-stage-v1.fixtures.json").required("valid").get(1).required("record").deepCopy();
        ((ObjectNode) stage.path("run").path("runtime")).put("runtimeBindingId", "binding");
        stage.set("inputRef", inputRef);
        stage.set("permissionRef", resource("managed-extension-command-permission", permission));
        ObjectNode ref = resource("managed-tool_stage", stage);
        project("tool_stage", "stage-1", "opening-command", ref);
        grant = JSON.createObjectNode().put("operationId", "opening-command").put("domain", "tool_stage").put("operationRevision", 1)
                .put("ownerId", "runtime").put("workspaceGeneration", "1").put("leaseDurationMs", 60_000).put("expiresAt", System.currentTimeMillis() + 60_000);
        grant.set("sessionKey", JSON.valueToTree(Map.of("tenantId", "tenant", "workspaceId", "workspace", "sessionId", "harness")));
        grant.set("resourceScope", JSON.valueToTree(Map.of("recordRef", ref, "phases", List.of("execute", "status", "cancel"))));
        operation = JSON.createObjectNode().put("kind", "extension-command").put("operationId", "stage-1").put("action", "execute")
                .put("toolName", "shell").put("revision", 1).put("extensionId", EXTENSION);
        operation.set("grant", grant);
        operation.set("input", JSON.createObjectNode().put("description", "cwd").put("command", "pwd"));
        ObjectNode bundle = JSON.createObjectNode().put("kind", "managed-extension-config-bundle").put("formatVersion", 1).put("configRevision", 1);
        bundle.set("packages", JSON.valueToTree(List.of(Map.of("pin", Map.of("extensionId", EXTENSION)))));
        ObjectNode config = (ObjectNode) fixtures("managed-config-install-v1.fixtures.json").required("valid").get(2).required("content").deepCopy();
        config.put("operationId", config.required("command").required("operationId").textValue()).put("revision", 1).putNull("previousRecordRef");
        config.set("bundleRef", resource("managed-extension-config-bundle", bundle));
        activeConfig = config;
        activeConfigRef = resource("managed-config_install", config);
        project("config_install", "hosted-mcp-settings", "config-command", activeConfigRef);
        jdbc.update("UPDATE ma_session_record SET settled_at=0 WHERE domain='config_install'");
    }

    @Test
    void readsTheCommittedInputAndPermissionAndRejectsSubstitutionOrStaleGrants() {
        verify();
        ((ObjectNode) operation.get("input")).put("command", "different-command");
        assertEquals(403, assertThrows(RuntimeBrokerException.class, this::verify).getStatusCode());
        ((ObjectNode) operation.get("input")).put("command", "pwd");
        grant.put("operationRevision", 2);
        assertThrows(RuntimeBrokerException.class, this::verify);
        grant.put("operationRevision", 1).put("ownerId", "another-runtime");
        assertEquals(400, assertThrows(RuntimeBrokerException.class, this::verify).getStatusCode());
    }

    @Test
    void recoveryReadsTheOriginalStageWhileConfigurationAdmissionIsClosed() {
        jdbc.update("DELETE FROM ma_session_record WHERE domain='config_install'");
        assertThrows(RuntimeBrokerException.class, this::verify);
        operation.put("action", "status");
        verify();
        operation.put("action", "cancel");
        verify();
    }

    @Test
    void dispatchUsesTheLiveSqlSelectionAndRecoveryRetainsTheCommittedDecision() {
        verify();
        jdbc.update("UPDATE ma_session SET selected_approval_mode=NULL, approval_revision=0 WHERE tenant_id=? AND session_id=?",
                "tenant".getBytes(java.nio.charset.StandardCharsets.UTF_8), "harness".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        assertThrows(RuntimeBrokerException.class, this::verify);
        operation.put("action", "status");
        verify();
        operation.put("action", "cancel");
        verify();
    }

    @Test
    void failedOrUncommittedApplyKeepsOldCommandsButCommittedBarrierRefusesExecution() throws IOException {
        for (String phase : List.of("failed", "preparing", "prepared", "committed")) {
            ObjectNode next = activeConfig.deepCopy();
            next.put("phase", phase).put("revision", 2).put("configRevision", 2).put("previousConfigRevision", 1);
            String applyId = UUID.randomUUID().toString();
            next.put("operationId", applyId).put("phaseOperationId", applyId);
            ((ObjectNode) next.get("command")).put("operationId", applyId).put("expectedRevision", 1);
            next.set("previousRecordRef", activeConfigRef);
            next.set("previousBundleRef", activeConfig.get("bundleRef"));
            next.putArray("enableAckRefs");
            if ("failed".equals(phase)) {
                next.set("error", JSON.createObjectNode().put("code", "extension_prepare_failed"));
            } else {
                next.putNull("error");
            }
            ObjectNode ref = resource("managed-config_install", next);
            jdbc.update("UPDATE ma_session_record SET revision=2, record_resource_id=?, settled_at=? WHERE domain='config_install'",
                    ref.get("resourceId").asText(), "committed".equals(phase) ? null : 0L);
            if ("committed".equals(phase)) {
                assertEquals(403, assertThrows(RuntimeBrokerException.class, this::verify).getStatusCode());
                operation.put("action", "status");
                verify();
                operation.put("action", "cancel");
                verify();
                operation.put("action", "execute");
            } else {
                verify();
            }
        }
    }

    private void verify() { verifier.verify(runtime, session, JSON.convertValue(operation, new TypeReference<>() { })); }

    private ObjectNode resource(String kind, JsonNode body) throws IOException {
        byte[] bytes = JSON.writeValueAsBytes(body);
        String id = UUID.randomUUID().toString();
        String scope = ManagedSessionStore.sessionScopeKey("tenant", "harness");
        jdbc.update("INSERT INTO ma_resource (resource_key, session_scope_key, tenant_id, workspace_id, session_id, resource_id, kind,"
                        + " schema_version, byte_length, sha256, storage_kind, inline_bytes, state, gmt_create)"
                        + " VALUES (?, ?, 'tenant', 'workspace', 'harness', ?, ?, 1, ?, ?, 'MYSQL_INLINE', ?, 'REFERENCED', 0)",
                ManagedSchemaKeys.key(scope, id), scope, id, kind, bytes.length, DigestUtils.sha256Hex(bytes), bytes);
        return JSON.createObjectNode().put("resourceId", id).put("kind", kind).put("schemaVersion", 1).put("byteLength", bytes.length)
                .put("digest", DigestUtils.sha256Hex(bytes));
    }

    private void project(String domain, String id, String opening, JsonNode ref) {
        jdbc.update("INSERT INTO ma_session_record (session_scope_key, record_key, tenant_id, workspace_id, session_id, domain, record_id,"
                        + " operation_hash, revision, record_resource_id, gmt_create) VALUES (?, ?, 'tenant', 'workspace', 'harness', ?, ?, ?, 1, ?, 0)",
                ManagedSessionStore.sessionScopeKey("tenant", "harness"), ManagedExtensionProjection.recordKey("harness", domain, id),
                domain, id, DigestUtils.sha256Hex(opening), ref.get("resourceId").textValue());
    }

    private static JsonNode fixtures(String name) throws IOException {
        Path current = Path.of(System.getProperty("user.dir")).toAbsolutePath();
        for (int depth = 0; depth < 6 && current != null; depth++, current = current.getParent()) {
            Path path = current.resolve("packages/core/src/managed-runtime/contracts").resolve(name);
            if (Files.isRegularFile(path)) {
                return JSON.readTree(path.toFile());
            }
        }
        throw new AssertionError("Missing shared Managed extension fixtures");
    }
}
