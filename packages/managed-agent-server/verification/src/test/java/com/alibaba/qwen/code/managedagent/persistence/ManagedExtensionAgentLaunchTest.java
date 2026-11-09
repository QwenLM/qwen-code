package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.runtimebroker.ManagedExtensionExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.commons.codec.digest.DigestUtils;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertThrows;

class ManagedExtensionAgentLaunchTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final SessionRecord parent = new SessionRecord("tenant", "parent", "agent", null, "Parent", "ACTIVE",
            null, null, 0, 0, 0, 0, 0, null, 0, new ContextBinding("tenant", "workspace", 1, "storage", ".", "config", 1),
            "yolo", WorkspaceToolProfiles.SHELL);
    private JdbcTemplate jdbc;
    private ObjectNode owner;

    @BeforeEach
    void setup() {
        var source = new DriverManagerDataSource("jdbc:h2:mem:extension-agent-owner-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "");
        ManagedSchema.initialize(source);
        jdbc = new JdbcTemplate(source);
        String request = DigestUtils.sha256Hex("request");
        String capability = ManagedExtensionExecutionProfile.DEVELOPER_CAPABILITY_DIGEST;
        jdbc.update("INSERT INTO ma_runtime_slot (request_key, tenant_id, workspace_id, workspace_generation,"
                + " canonical_cwd, capability_digest, isolation_class, isolation_key, provisioner_kind, storage_id,"
                + " last_generation, active_binding_id) VALUES (?, 'tenant', 'workspace', '1', '/workspace', ?,"
                + " 'session', 'parent', 'local-process', 'storage', 1, 'binding')", request, capability);
        jdbc.update("INSERT INTO ma_runtime_binding (binding_id, request_key, scope_key, tenant_id, workspace_id,"
                + " workspace_generation, canonical_cwd, capability_digest, isolation_class, isolation_key, provisioner_kind,"
                + " storage_id, runtime_generation, binding_state, runtime_instance_id, runtime_lease_id,"
                + " attestation_generation, drain_requested, operation_generation, record_version, last_active_at)"
                + " VALUES ('binding', ?, ?, 'tenant', 'workspace', '1', '/workspace', ?, 'session', 'parent',"
                + " 'local-process', 'storage', 1, 'READY', 'worker', 'lease', 1, FALSE, 0, 1, 0)",
                request, DigestUtils.sha256Hex("scope"), capability);
        owner = JSON.createObjectNode().put("executionMode", "developer-process-group");
        owner.putObject("runtime").put("bindingId", "binding").put("generation", "1").put("workspaceGeneration", "1");
    }

    @Test
    void onlyTheOriginalReadyParentOwnerCanLaunchFromTheActivePackageSnapshot() {
        verify();
        jdbc.update("UPDATE ma_runtime_slot SET active_binding_id='replacement'");
        assertThrows(ManagedAgentException.class, this::verify);
        jdbc.update("UPDATE ma_runtime_slot SET active_binding_id='binding'");
        jdbc.update("UPDATE ma_runtime_binding SET drain_requested=TRUE");
        assertThrows(ManagedAgentException.class, this::verify);
        jdbc.update("UPDATE ma_runtime_binding SET drain_requested=FALSE, runtime_generation=2");
        jdbc.update("UPDATE ma_runtime_slot SET last_generation=2");
        assertThrows(ManagedAgentException.class, this::verify);
    }

    @Test
    void rejectsAnotherHarnessStorageOrExecutionProfileWithoutBorrowingItsOwner() {
        jdbc.update("UPDATE ma_runtime_binding SET isolation_key='child'");
        assertThrows(ManagedAgentException.class, this::verify);
        jdbc.update("UPDATE ma_runtime_binding SET isolation_key='parent', storage_id='other-storage'");
        assertThrows(ManagedAgentException.class, this::verify);
        jdbc.update("UPDATE ma_runtime_binding SET storage_id='storage', capability_digest=?", WorkspaceExecutionProfile.CAPABILITY_DIGEST);
        assertThrows(ManagedAgentException.class, this::verify);
        jdbc.update("UPDATE ma_runtime_binding SET capability_digest=?", ManagedExtensionExecutionProfile.DEVELOPER_CAPABILITY_DIGEST);
        owner.put("executionMode", "linux-cgroup");
        assertThrows(ManagedAgentException.class, this::verify);
        owner.put("executionMode", "developer-process-group");
        ((ObjectNode) owner.get("runtime")).put("workspaceGeneration", "2");
        assertThrows(ManagedAgentException.class, this::verify);
    }

    private void verify() {
        ManagedExtensionAgentLaunch.requireRuntimeOwner(jdbc, parent, owner);
    }
}
