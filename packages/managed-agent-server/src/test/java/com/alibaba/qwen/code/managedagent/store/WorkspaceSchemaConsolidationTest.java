package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class WorkspaceSchemaConsolidationTest {
    private ManagedSchemaJdbcTemplate jdbc;
    private DataSourceTransactionManager manager;
    private TransactionTemplate transaction;
    private DriverManagerDataSource mysqlAdmin;
    private String mysqlDatabase;

    @BeforeEach
    void setUp() {
        DriverManagerDataSource source;
        String port = System.getProperty("managed.schema.mysql.port");
        if (port == null) {
            source = new DriverManagerDataSource("jdbc:h2:mem:workspace-consolidation-" + UUID.randomUUID()
                    + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "");
        } else {
            if (!port.matches("[0-9]{1,5}") || Integer.parseInt(port) > 65535) {
                throw new IllegalArgumentException("Invalid task-local MySQL port");
            }
            mysqlDatabase = "managed_schema_workspace_" + UUID.randomUUID().toString().replace("-", "");
            mysqlAdmin = new DriverManagerDataSource("jdbc:mysql://127.0.0.1:" + port + "/mysql", "root", "");
            new ManagedSchemaJdbcTemplate(mysqlAdmin).execute("CREATE DATABASE " + mysqlDatabase);
            source = new DriverManagerDataSource("jdbc:mysql://127.0.0.1:" + port + "/" + mysqlDatabase, "root", "");
        }
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        manager = new DataSourceTransactionManager(source);
        transaction = new TransactionTemplate(manager);
    }

    @AfterEach
    void cleanUp() {
        if (mysqlAdmin != null && mysqlDatabase != null) {
            new ManagedSchemaJdbcTemplate(mysqlAdmin).execute("DROP DATABASE " + mysqlDatabase);
        }
    }

    @Test
    void aliasesAcrossTenantsShareOnlyThePhysicalOwner() {
        var store = new WorkspaceCsiReservationStore(jdbc, manager, new ObjectMapper());
        var first = registration("tenant", "storage", "same-volume");
        var second = registration("other-tenant", "other-storage", "same-volume");
        store.register(first);
        store.register(second);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage", Integer.class)).isEqualTo(2);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage_owner", Integer.class)).isEqualTo(1);
        assertThat(store.inspect(first).phase()).isEqualTo("RELEASED");
        assertThat(store.inspect(second).phase()).isEqualTo("RELEASED");
        assertThatThrownBy(() -> store.register(registration("tenant", "storage", "changed-volume")))
                .isInstanceOf(RuntimeException.class);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage_owner", Integer.class)).isEqualTo(1);
    }

    @Test
    void childWorkspaceIdentityOutlivesClaimsAndRejectsTheExpiredWorker() {
        root("root");
        var store = new ChildWorkspaceStore(jdbc, manager);
        var parent = new ContextBinding("tenant", "root", 1, "storage", ".", "config", 1);
        long now = System.currentTimeMillis();
        var admitted = store.admit("tenant", "parent-session", "run", parent, now);
        var first = store.claim(admitted, "old-worker", now, 100);
        var second = store.claim(admitted, "new-worker", now + 101, 1000);
        assertThat(second.claimGeneration()).isEqualTo(first.claimGeneration() + 1);
        assertThat(store.transition(first, "old-worker", ChildWorkspaceStore.READY, Map.of(), now + 102)).isFalse();
        assertThat(store.renew(first, "old-worker", now + 2000, now + 102)).isFalse();
        assertThat(store.transition(second, "new-worker", ChildWorkspaceStore.READY,
                Map.of("base_commit", "base", "child_cwd_relative", "children/run"), now + 102)).isTrue();
        store.release(first, "old-worker", now + 103);
        assertThat(store.find("tenant", "parent-session", "run").claimedBy()).isEqualTo("new-worker");
        store.release(second, "new-worker", now + 104);
        assertThat(store.admit("tenant", "parent-session", "run", parent, now + 105).baseCommit()).isEqualTo("base");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_workspace WHERE workspace_kind = 'CHILD_GIT'", Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE operation_kind = 'CHILD_WORKSPACE'", Integer.class)).isEqualTo(1);
    }

    @Test
    void childPermissionsUseTheCurrentParentGrant() {
        root("root");
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role) VALUES (?, ?, ?, 'OWNER')",
                "tenant", "root", "actor".getBytes(StandardCharsets.UTF_8));
        var store = new ChildWorkspaceStore(jdbc, manager);
        var child = store.admit("tenant", "parent", "run",
                new ContextBinding("tenant", "root", 1, "storage", ".", "config", 1), System.currentTimeMillis());
        var registry = new ManagedWorkspaceRegistry(jdbc);
        assertThat(registry.accessOf("tenant", "actor", child.childWorkspaceId()).name()).isEqualTo("OWNER");
        jdbc.update("DELETE FROM ma_workspace_access WHERE tenant_id = ? AND workspace_id = ?", "tenant", "root");
        assertThat(registry.accessOf("tenant", "actor", child.childWorkspaceId()).canRead()).isFalse();
    }

    @Test
    void childSessionExecutionDoesNotAcquireAuthorityFromItsSyntheticActor() {
        root("root");
        long now = System.currentTimeMillis();
        for (String id : java.util.List.of("parent", "child")) {
            jdbc.update("INSERT INTO ma_session (tenant_id, session_id, agent_id, status, gmt_create, gmt_modified,"
                    + " workspace_id, workspace_generation, workspace_storage_id, cwd_relative, context_config_ref,"
                    + " context_revision, workspace_config_ref, workspace_policy_ref, creator_actor_key, parent_session_id)"
                    + " VALUES ('tenant', ?, 'qwen-code', 'ACTIVE', ?, ?, 'root', 1, 'storage', '.', ?, 1, ?, ?, ?, ?)",
                    id, now, now, WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, WorkspaceExecutionProfile.CONFIG_REF,
                    WorkspaceExecutionProfile.POLICY_REF, ("parent".equals(id) ? "actor" : "child:parent")
                            .getBytes(StandardCharsets.UTF_8), "parent".equals(id) ? null : "parent");
        }
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role) VALUES ('tenant', 'root', ?, 'OWNER')",
                "actor".getBytes(StandardCharsets.UTF_8));
        var binding = new ContextBinding("tenant", "root", 1, "storage", ".", WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, 1);
        var child = new StoreModels.SessionRecord("tenant", "child", "qwen-code", "1", "Child", "ACTIVE", null,
                null, 0, 0, 0, now, now, null, 0, binding, "yolo", "hosted-workspace-files/1");
        var authority = new WorkspaceExecutionStore(jdbc, manager);
        authority.authorize(child);
        jdbc.update("DELETE FROM ma_workspace_access WHERE tenant_id = ? AND workspace_id = ?", "tenant", "root");
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role) VALUES ('tenant', 'root', ?, 'OWNER')",
                "child:parent".getBytes(StandardCharsets.UTF_8));
        assertThatThrownBy(() -> authority.authorize(child)).isInstanceOf(com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException.class);
    }

    @Test
    void expiredMaintenanceClaimCannotReleaseOrReplaceTheOriginalPhysicalHolder() {
        root("root");
        var store = new ChildWorkspaceStore(jdbc, manager);
        var authority = new WorkspaceExecutionStore(jdbc, manager);
        var storage = new ContextBinding("tenant", "root", 1, "storage", ".", WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, 1);
        long now = System.currentTimeMillis();
        var admitted = store.admit("tenant", "parent", "run", storage, now);
        var original = store.claim(admitted, "original-worker", now, 1000);
        String step = authority.holdForMaintenance(storage, admitted.childWorkspaceId(), original.claimGeneration());
        String originalHolder = jdbc.queryForObject("SELECT holder_key FROM ma_storage_owner", String.class);
        assertThat(authority.releaseStaleMaintenance(now + 60_000, 0)).isZero();
        var recovery = new WorkspaceMaintenanceRecovery(jdbc, manager, null);
        var identity = recovery.inspect(storage, admitted.childWorkspaceId(), original.claimGeneration());
        assertThat(identity.get("executionId")).isInstanceOf(String.class);
        assertThat(identity.get("recoveryBlocker")).isEqualTo("maintenance_stop_unverified");
        assertThatThrownBy(() -> recovery.reconcileAfterReboot(storage, admitted.childWorkspaceId(), original.claimGeneration(),
                (String) identity.get("executionId"))).isInstanceOf(com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException.class);
        assertThat(store.claim(admitted, "replacement-worker", now + 1001, 60_000)).isNull();
        assertThat(recovery.inspect(storage, admitted.childWorkspaceId(), original.claimGeneration())).isEqualTo(identity);
        assertThat(jdbc.queryForObject("SELECT maintenance_generation FROM ma_storage_owner", Long.class))
                .isEqualTo(original.claimGeneration());
        authority.releaseMaintenance(storage, admitted.childWorkspaceId(), original.claimGeneration() + 1, step);
        assertThat(jdbc.queryForObject("SELECT holder_key FROM ma_storage_owner", String.class)).isEqualTo(originalHolder);
        authority.releaseMaintenance(storage, admitted.childWorkspaceId(), original.claimGeneration(), step);
        var replacement = store.claim(admitted, "replacement-worker", now + 1001, 60_000);
        authority.holdForMaintenance(storage, admitted.childWorkspaceId(), replacement.claimGeneration());
        assertThat(jdbc.queryForObject("SELECT holder_key FROM ma_storage_owner", String.class)).isNotEqualTo(originalHolder);
    }

    @Test
    void eachPhysicalStepKeepsItsOwnIdentityEvenWithinOneClaim() {
        root("root");
        var children = new ChildWorkspaceStore(jdbc, manager);
        var authority = new WorkspaceExecutionStore(jdbc, manager);
        var binding = new ContextBinding("tenant", "root", 1, "storage", ".", WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, 1);
        long now = System.currentTimeMillis();
        var admitted = children.admit("tenant", "parent", "run", binding, now);
        var claimed = children.claim(admitted, "worker", now, 60_000);
        String first = authority.holdForMaintenance(binding, claimed.childWorkspaceId(), claimed.claimGeneration());
        var recovery = new WorkspaceMaintenanceRecovery(jdbc, manager, null);
        var inFlight = recovery.inspect(binding, claimed.childWorkspaceId(), claimed.claimGeneration());
        assertThatThrownBy(() -> authority.holdForMaintenance(binding, claimed.childWorkspaceId(), claimed.claimGeneration()))
                .isInstanceOfSatisfying(com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException.class,
                        error -> assertThat(error.getCode()).isEqualTo("maintenance_stop_unverified"));
        assertThat(recovery.inspect(binding, claimed.childWorkspaceId(), claimed.claimGeneration())).isEqualTo(inFlight);
        authority.releaseMaintenance(binding, claimed.childWorkspaceId(), claimed.claimGeneration(), first);
        String second = authority.holdForMaintenance(binding, claimed.childWorkspaceId(), claimed.claimGeneration());
        assertThat(second).isNotEqualTo(first);
        authority.releaseMaintenance(binding, claimed.childWorkspaceId(), claimed.claimGeneration(), first);
        assertThat(jdbc.queryForObject("SELECT holder_key FROM ma_storage_owner", String.class)).isNotNull();
        var current = new WorkspaceMaintenanceRecovery(jdbc, manager, null).inspect(binding,
                claimed.childWorkspaceId(), claimed.claimGeneration());
        assertThat(current.get("executionId")).isEqualTo(second);
        assertThat(current.get("state")).isEqualTo("EXECUTING");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation_work WHERE work_kind = 'RECOVERY_EVIDENCE' AND evidence_resource_key IS NOT NULL", Integer.class)).isEqualTo(2);
        authority.releaseMaintenance(binding, claimed.childWorkspaceId(), claimed.claimGeneration(), second);
        assertThat(jdbc.queryForObject("SELECT holder_key FROM ma_storage_owner", String.class)).isNull();
    }

    @Test
    void privateRecoveryInventoryExcludesPublicOnlyBodiesAtScale() throws Exception {
        String scope = ManagedSessionStore.sessionScopeKey("tenant", "session");
        byte[] body = "{}".getBytes(StandardCharsets.UTF_8);
        java.util.List<Object[]> resources = new java.util.ArrayList<>();
        java.util.List<Object[]> roots = new java.util.ArrayList<>();
        for (int index = 0; index < 4098; index++) {
            String id = index == 0 ? "checkpoint" : "public-page-" + index;
            String resource = WorkspaceOperations.hash(scope, id);
            resources.add(new Object[] {resource, scope, id.getBytes(StandardCharsets.UTF_8),
                    index == 0 ? "managed-checkpoint" : "managed-public-snapshot-page", WorkspaceEvidenceResources.digest(body), body});
            roots.add(new Object[] {scope, index == 0 ? "JOURNAL" : "SNAPSHOT", WorkspaceOperations.hash("owner", id), resource,
                    index == 0 ? 1L : null, id.getBytes(StandardCharsets.UTF_8)});
        }
        jdbc.batchUpdate("INSERT INTO ma_resource (resource_key, session_scope_key, tenant_id, workspace_id, session_id, resource_id, kind, schema_version, byte_length, sha256, storage_kind, inline_bytes, publish_command_id, state, gmt_create) VALUES (?, ?, 'tenant', 'root', 'session', ?, ?, 1, 2, ?, 'MYSQL_INLINE', ?, 'fixture', 'REFERENCED', " + ManagedSchemaTime.SQL_NOW + ")", resources);
        jdbc.batchUpdate("INSERT INTO ma_resource_ref (session_scope_key, owner_kind, owner_key, owner_revision, resource_key, tenant_id, workspace_id, session_id, journal_revision, resource_id, gmt_create) VALUES (?, ?, ?, 1, ?, 'tenant', 'root', 'session', ?, ?, " + ManagedSchemaTime.SQL_NOW + ")", roots);
        var catalog = new WorkspaceCsiCheckpointSnapshotStore(jdbc.getDataSource(),
                new com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository(jdbc.getDataSource(),
                        new com.alibaba.qwen.code.runtimebroker.AesGcmSecretProtector("test", new byte[32])), new ObjectMapper());
        var key = new ObjectMapper().createObjectNode().put("tenantId", "tenant").put("workspaceId", "root").put("sessionId", "session");
        try (var connection = jdbc.getDataSource().getConnection()) {
            connection.setTransactionIsolation(java.sql.Connection.TRANSACTION_REPEATABLE_READ);
            connection.setAutoCommit(false);
            var inventory = catalog.resources(connection, key, scope, 1);
            assertThat(inventory.size()).isOne();
            assertThat(inventory.get(0).path("ref").path("resourceId").asText()).isEqualTo("checkpoint");
            connection.rollback();
        }
    }

    @Test
    void aDeleteIntentBlocksNewProofReferencesAndReads() {
        String owner = WorkspaceOperations.hash("proof-owner");
        byte[] bytes = "proof".getBytes(StandardCharsets.UTF_8);
        String resource = transaction.execute(ignored -> WorkspaceEvidenceResources.publish(jdbc, "tenant", "root", "session", owner, bytes));
        jdbc.update("UPDATE ma_resource SET deletion_operation_key = ? WHERE resource_key = ?", WorkspaceOperations.hash("delete"), resource);
        assertThatThrownBy(() -> transaction.execute(ignored -> WorkspaceEvidenceResources.publish(jdbc, "tenant", "root", "session", owner, bytes)))
                .isInstanceOf(IllegalStateException.class);
        assertThatThrownBy(() -> WorkspaceEvidenceResources.read(jdbc, resource, WorkspaceEvidenceResources.digest(bytes)))
                .isInstanceOf(IllegalStateException.class);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource_ref", Integer.class)).isOne();
    }

    @Test
    void recoveryProofIsImmutableAndReachableThroughItsNamedWorkRoot() {
        String id = UUID.randomUUID().toString();
        var operations = new WorkspaceOperations(jdbc, "tenant");
        byte[] evidence = "original-worker-confirmation".getBytes(StandardCharsets.UTF_8);
        transaction.executeWithoutResult(status -> {
            operations.create(WorkspaceOperations.Kind.WORKSPACE_OPERATOR_RECOVERY, id,
                    WorkspaceOperations.values("binding_id", "original-binding", "runtime_generation", 4L,
                            "storage_id", "storage", "state", "PREPARED"));
            String owner = WorkspaceOperations.hash(operations.key(WorkspaceOperations.Kind.WORKSPACE_OPERATOR_RECOVERY, id), "proof");
            String resource = WorkspaceEvidenceResources.publish(jdbc, "tenant", "root", "session", owner, evidence);
            operations.insertWork(WorkspaceOperations.Kind.WORKSPACE_OPERATOR_RECOVERY, id, "RECOVERY_EVIDENCE",
                    WorkspaceOperations.hash("execution"), "execution", "session",
                    WorkspaceOperations.values("evidence_resource_key", resource,
                            "evidence_sha256", WorkspaceEvidenceResources.digest(evidence)), "COMPLETE");
        });
        var work = operations.findWork(WorkspaceOperations.Kind.WORKSPACE_OPERATOR_RECOVERY, id,
                "RECOVERY_EVIDENCE", WorkspaceOperations.hash("execution"), false);
        assertThat(WorkspaceEvidenceResources.read(jdbc, (String) work.get("evidence_resource_key"),
                (String) work.get("evidence_sha256"))).isEqualTo(evidence);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource_ref WHERE owner_kind = 'OPERATION_WORK'", Integer.class)).isEqualTo(1);
        assertThatThrownBy(() -> transaction.executeWithoutResult(status -> operations.update(
                WorkspaceOperations.Kind.WORKSPACE_OPERATOR_RECOVERY, id, WorkspaceOperations.values("state", "COMPLETED"))))
                .isInstanceOf(IllegalStateException.class);
        assertThat(operations.find(WorkspaceOperations.Kind.WORKSPACE_OPERATOR_RECOVERY, id, false).get("state")).isEqualTo("PREPARED");
    }

    private void root(String id) {
        WorkspaceTestStorage.register(jdbc, "tenant", "storage");
        jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation, storage_id, display_name,"
                + " config_ref, policy_ref, state) VALUES (?, ?, 1, 'storage', 'Root', ?, ?, 'ACTIVE')",
                "tenant", id, WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
    }

    private static WorkspaceCsiRegistration registration(String tenant, String storage, String handle) {
        return new WorkspaceCsiRegistration(tenant, storage, "cluster", "namespace", "pvc", "pvc-uid",
                "pv", "pv-uid", "driver", handle, "backend", "disk", "/workspace", 1);
    }
}
