package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.time.Clock;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class WorkspaceQueryScaleMySqlIT {
    @Test
    void tenfoldHistoryKeepsRecoveryBlockersAndChildClaimsBoundedByIndexes() {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase()) {
            ManagedSchema.initialize(database.source());
            var jdbc = new CapturingJdbc(database.source());
            var manager = new DataSourceTransactionManager(database.source());
            var transactions = new TransactionTemplate(manager);
            var store = new ManagedAgentStore(jdbc, new ObjectMapper(), Clock.systemUTC(), ignored -> {},
                    new ManagedWorkspaceRegistry(jdbc), new ManagedAgentProperties());
            String session = transactions.execute(ignored -> store.insertSessionCommand("tenant", "actor", "CREATE_SESSION",
                    "create", "digest", "qwen-code", null, null, List.of(), null)).sessionId();
            String scope = ManagedSessionStore.sessionScopeKey("tenant", session);
            ManagedReceipts.insertCreation(jdbc, "tenant", "actor".getBytes(java.nio.charset.StandardCharsets.UTF_8), "creation", "digest", session, null, 1);
            jdbc.update("UPDATE ma_session SET workspace_id = X'726f6f74', workspace_generation = 1, workspace_storage_id = X'73746f72616765',"
                    + " cwd_relative = '.', context_config_ref = ?, context_revision = 1, workspace_config_ref = ?, workspace_policy_ref = ?"
                    + " WHERE tenant_id = X'74656e616e74' AND session_id = ?", WorkspaceExecutionProfile.CONTEXT_CONFIG_REF,
                    WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF, session);
            jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation, storage_id, display_name, config_ref, policy_ref, state)"
                    + " VALUES ('tenant', 'root', 1, 'storage', 'Root', ?, ?, 'ACTIVE')",
                    WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
            var children = new ChildWorkspaceStore(jdbc, manager);
            var binding = new ContextBinding("tenant", "root", 1, "storage", ".", "config", 1);
            for (int index = 0; index < 5; index++) {
                children.admit("tenant", session, "due-" + index, binding, 1);
            }
            for (int size : new int[] {1000, 10000}) {
                addHistory(jdbc, scope, session, size == 1000 ? 0 : 1000, size);
                jdbc.execute("ANALYZE TABLE ma_operation, ma_workspace, ma_resource, ma_resource_ref");
                ObjectNode source = (ObjectNode) WorkspaceRecoveryStore.currentSource(jdbc, "tenant", "storage", session, false);
                assertThat(source.path("sessionId").asText()).isEqualTo(session);
                assertBounded(jdbc, jdbc.blocker, "ix_ma_operation_session_state", 5);
                assertBounded(jdbc, jdbc.deleteIntent, "ix_ma_resource_delete_intent", 5);
                assertThat(children.findDue(10, 5)).hasSize(5);
                assertBounded(jdbc, jdbc.due, "ix_ma_operation_due", 5);
                source.putObject("head").put("tenantId", "tenant").put("workspaceId", "root")
                        .put("sessionId", session).put("journalRevision", 1);
                ObjectNode ref = new ObjectMapper().createObjectNode().put("resourceId", "history-resource-" + (size - 1))
                        .put("kind", "managed-definition").put("schemaVersion", 1).put("byteLength", 2)
                        .put("digest", WorkspaceRecoveryStore.hash("{}".getBytes(java.nio.charset.StandardCharsets.UTF_8)));
                assertThat(new WorkspaceRecoveryReader(jdbc, null).resource(source, ref).path("bytesBase64").asText()).isEqualTo("e30=");
                assertBounded(jdbc, jdbc.resource, "PRIMARY", 5);
                assertBounded(jdbc, jdbc.reference, "ix_ma_ref_resource", 5);
            }
        }
    }

    @Test
    void tenfoldClosedAliasHistoryKeepsPhysicalAuthorityInventoryBounded() {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase()) {
            ManagedSchema.initialize(database.source());
            var jdbc = new CapturingJdbc(database.source());
            WorkspaceTestStorage.register(jdbc, "other-tenant", "other-storage");
            String alias = com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository.storageAliasKey("other-tenant", "other-storage");
            String tenantKey = ManagedSchemaKeys.key("other-tenant");
            jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation, storage_id, display_name, config_ref, policy_ref, state)"
                    + " VALUES ('other-tenant', 'other-workspace', 1, 'other-storage', 'Workspace', 'config', 'policy', 'ACTIVE')");
            var repository = new com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository(database.source(),
                    new com.alibaba.qwen.code.runtimebroker.security.AesGcmSecretProtector("test", new byte[32]));
            var request = new com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest(
                    new com.alibaba.qwen.code.runtimebroker.RuntimeScope("other-tenant", "other-workspace", "1", "/scale",
                            "sha256:" + "a".repeat(64), "workspace"), null, "local-process", "other-storage");
            var failed = repository.findOrCreate(request);
            var claimed = repository.claimOperation(failed.getBindingId(), "scale-worker", java.time.Duration.ofMinutes(1));
            repository.compareAndSet(claimed, claimed.withState(com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord.State.FAILED,
                    null, java.time.Instant.now()));
            new WorkspaceOperations(jdbc, "other-tenant").create(WorkspaceOperations.Kind.STORAGE_MIGRATION, "pending-migration",
                    WorkspaceOperations.values("storage_id", "other-storage", "state", "RETIRING"));
            var child = new ChildWorkspaceStore(jdbc, new DataSourceTransactionManager(database.source())).admit(
                    "other-tenant", "collected-parent", "pending-child", new ContextBinding("other-tenant", "other-workspace", 1,
                            "other-storage", ".", WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, 1), 1);
            String childKey = WorkspaceOperations.key(WorkspaceOperations.Kind.CHILD_WORKSPACE, "other-tenant", child.childWorkspaceId());
            jdbc.update("UPDATE ma_operation SET state = ? WHERE operation_key = ?", ChildWorkspaceStore.MERGED, childKey);
            jdbc.update("UPDATE ma_workspace SET child_state = ? WHERE tenant_id = ? AND workspace_id = ?", ChildWorkspaceStore.MERGED,
                    "other-tenant", child.childWorkspaceId());
            for (int size : new int[] {1000, 10000}) {
                int from = size == 1000 ? 0 : 1000;
                var sessions = new ArrayList<Object[]>();
                var heads = new ArrayList<Object[]>();
                var bindings = new ArrayList<Object[]>();
                var operations = new ArrayList<Object[]>();
                var children = new ArrayList<Object[]>();
                var owners = new ArrayList<Object[]>();
                for (int index = from; index < size; index++) {
                    String id = "closed-" + index;
                    String sessionKey = ManagedSchemaKeys.key(id);
                    sessions.add(new Object[] {id, tenantKey, sessionKey, ManagedSessionStore.sessionScopeKey("other-tenant", id)});
                    heads.add(new Object[] {tenantKey, sessionKey, id, id});
                    bindings.add(new Object[] {id, ManagedSchemaKeys.key(id), ManagedSchemaKeys.key("scope", id), alias});
                    operations.add(new Object[] {ManagedSchemaKeys.key("operation", id), ManagedSchemaKeys.key("other-tenant"), id,
                            ManagedSchemaKeys.key(id), alias});
                    children.add(new Object[] {ManagedSchemaKeys.key("child-operation", id), ManagedSchemaKeys.key("other-tenant"), "child-" + id,
                            ManagedSchemaKeys.key("child", id), alias, index % 2 == 0 ? ChildWorkspaceStore.MERGED : ChildWorkspaceStore.DISCARDED});
                    owners.add(new Object[] {ManagedSchemaKeys.key("old-physical", id), ManagedSchemaKeys.key("old-physical", id)});
                }
                jdbc.batchUpdate("INSERT INTO ma_session (tenant_id, session_id, session_kind, tenant_key, session_key, session_scope_key, workspace_storage_id,"
                        + " resource_gc_completed, retirement_generation, retired_at, gmt_create, gmt_modified) VALUES ('other-tenant', ?, 'CONTROL', ?, ?, ?, 'other-storage', TRUE, 1, 1, 1, 1)", sessions);
                jdbc.batchUpdate("INSERT INTO ma_session_head (tenant_key, harness_key, tenant_id, session_id, harness_session_id, head_kind, workspace_id, storage_version, state, writer_generation, journal_revision, committed_sequence, activation_epoch, compacted_through_revision, recovery_status, gmt_create, gmt_modified) VALUES (?, ?, 'other-tenant', ?, ?, 'MANAGED_SESSION', 'other-workspace', 1, 'DELETED', 1, 0, 0, 0, 0, 'READY', " + ManagedSchemaTime.SQL_NOW + ", " + ManagedSchemaTime.SQL_NOW + ")", heads);
                jdbc.batchUpdate("INSERT INTO ma_runtime_binding (binding_id, request_key, scope_key, tenant_id, workspace_id, workspace_generation, canonical_cwd, capability_digest, isolation_class, provisioner_kind, storage_id, storage_alias_key, runtime_generation, binding_state, attestation_generation, drain_requested, operation_generation, record_version, last_active_at) VALUES (?, ?, ?, 'other-tenant', 'other-workspace', '1', '/scale', 'digest', 'workspace', 'local-process', 'other-storage', ?, 1, 'FAILED', 0, FALSE, 0, 0, " + ManagedSchemaTime.SQL_NOW + ")", bindings);
                jdbc.batchUpdate("INSERT INTO ma_operation (operation_key, scope_key, operation_kind, operation_id, tenant_id, target_kind, target_key, storage_key, state, phase, request_digest, request_json, gmt_create, gmt_modified)"
                        + " VALUES (?, ?, 'STORAGE_MIGRATION', ?, 'other-tenant', 'STORAGE', ?, ?, 'COMPLETED', 'COMPLETED', 'digest', '{}', 1, 1)", operations);
                jdbc.batchUpdate("INSERT INTO ma_operation (operation_key, scope_key, operation_kind, operation_id, tenant_id, target_kind, target_key, storage_key, state, phase, request_digest, request_json, gmt_create, gmt_modified)"
                        + " VALUES (?, ?, 'CHILD_WORKSPACE', ?, 'other-tenant', 'STORAGE', ?, ?, ?, 'SETTLED', 'digest', '{}', 1, 1)", children);
                jdbc.batchUpdate("INSERT INTO ma_storage_owner (storage_key, physical_key, storage_kind) VALUES (?, ?, 'LOCAL')", owners);
                jdbc.execute("ANALYZE TABLE ma_session, ma_session_head, ma_workspace, ma_runtime_binding, ma_operation, ma_storage_owner");
                var session = new Query(LocalStorageOwners.SESSION_AUTHORITY_SQL, new Object[] {"other-tenant", "other-storage"});
                assertThat(jdbc.queryForList(session.sql(), Integer.class, session.arguments())).isEmpty();
                assertBounded(jdbc, session, "ix_ma_session_storage_scope", 5);
                var runtime = new Query(LocalStorageOwners.RUNTIME_AUTHORITY_SQL, new Object[] {alias});
                assertThat(jdbc.queryForList(runtime.sql(), Integer.class, runtime.arguments())).containsExactly(1);
                assertBounded(jdbc, runtime, "ix_ma_runtime_storage_alias_state", 5);
                var operation = new Query(LocalStorageOwners.OPERATION_AUTHORITY_SQL, new Object[] {alias});
                assertThat(jdbc.queryForList(operation.sql(), Integer.class, operation.arguments())).containsExactly(1);
                assertBounded(jdbc, operation, "ix_ma_operation_storage", 5);
                String migrationKey = WorkspaceOperations.key(WorkspaceOperations.Kind.STORAGE_MIGRATION, "other-tenant", "pending-migration");
                jdbc.update("UPDATE ma_operation SET state = 'COMPLETED' WHERE operation_key = ?", migrationKey);
                assertThat(jdbc.queryForList(operation.sql(), Integer.class, operation.arguments())).isEmpty();
                assertBounded(jdbc, operation, "ix_ma_operation_storage", 5);
                jdbc.update("UPDATE ma_operation SET state = ? WHERE operation_key = ?", ChildWorkspaceStore.PREPARING, childKey);
                jdbc.update("UPDATE ma_workspace SET child_state = ? WHERE tenant_id = ? AND workspace_id = ?", ChildWorkspaceStore.PREPARING,
                        "other-tenant", child.childWorkspaceId());
                assertThat(jdbc.queryForList(operation.sql(), Integer.class, operation.arguments())).containsExactly(1);
                assertBounded(jdbc, operation, "ix_ma_operation_storage", 5);
                jdbc.update("UPDATE ma_operation SET state = ? WHERE operation_key = ?", ChildWorkspaceStore.MERGED, childKey);
                jdbc.update("UPDATE ma_workspace SET child_state = ? WHERE tenant_id = ? AND workspace_id = ?", ChildWorkspaceStore.MERGED,
                        "other-tenant", child.childWorkspaceId());
                jdbc.update("UPDATE ma_operation SET state = 'RETIRING' WHERE operation_key = ?", migrationKey);
                var head = new Query(LocalStorageOwners.HEAD_AUTHORITY_SQL, new Object[] {"other-tenant", tenantKey, "other-tenant", "other-storage"});
                assertThat(jdbc.queryForList(head.sql(), Integer.class, head.arguments())).isEmpty();
                assertBounded(jdbc, head, "ix_ma_session_storage_scope", 5);
                var holder = new Query(WorkspaceExecutionStore.ORIGINAL_HOLDER_SQL, new Object[] {failed.getBindingId(), failed.getGeneration()});
                assertThat(jdbc.queryForList(holder.sql(), String.class, holder.arguments())).isEmpty();
                assertBounded(jdbc, holder, "ix_ma_storage_owner_binding", 5);
            }
        }
    }

    private static void addHistory(CapturingJdbc jdbc, String scope, String session, int from, int to) {
        var operations = new ArrayList<Object[]>();
        var workspaces = new ArrayList<Object[]>();
        var resources = new ArrayList<Object[]>();
        var references = new ArrayList<Object[]>();
        for (int index = from; index < to; index++) {
            String child = "historical-child-" + index;
            String rawRun = "historical-run-" + index;
            operations.add(new Object[] {ManagedSchemaKeys.key("child", child), scope, scope, child.getBytes(java.nio.charset.StandardCharsets.UTF_8),
                    session.getBytes(java.nio.charset.StandardCharsets.UTF_8), "CHILD_WORKSPACE", ManagedSchemaKeys.key(child), "merged", "IDLE"});
            operations.add(new Object[] {ManagedSchemaKeys.key("close", child), scope, scope, ("close-" + child).getBytes(java.nio.charset.StandardCharsets.UTF_8),
                    session.getBytes(java.nio.charset.StandardCharsets.UTF_8), "CLOSE", ManagedSchemaKeys.key(session), "COMPLETED", "CONFIRMED"});
            workspaces.add(new Object[] {child.getBytes(java.nio.charset.StandardCharsets.UTF_8), child.getBytes(java.nio.charset.StandardCharsets.UTF_8),
                    session.getBytes(java.nio.charset.StandardCharsets.UTF_8), rawRun.getBytes(java.nio.charset.StandardCharsets.UTF_8)});
            String resourceId = "history-resource-" + index;
            String resourceKey = ManagedSessionStore.resourceKey(scope, resourceId);
            resources.add(new Object[] {resourceKey, scope, session.getBytes(java.nio.charset.StandardCharsets.UTF_8),
                    resourceId.getBytes(java.nio.charset.StandardCharsets.UTF_8), WorkspaceRecoveryStore.hash("{}".getBytes(java.nio.charset.StandardCharsets.UTF_8))});
            references.add(new Object[] {scope, ManagedSchemaKeys.key(resourceId), resourceKey,
                    session.getBytes(java.nio.charset.StandardCharsets.UTF_8), resourceId.getBytes(java.nio.charset.StandardCharsets.UTF_8)});
        }
        jdbc.batchUpdate("INSERT INTO ma_operation (operation_key, scope_key, session_scope_key, operation_id, tenant_id, session_id,"
                + " operation_kind, target_kind, target_key, state, phase, delivery_state, request_digest, request_json, available_at, gmt_create, gmt_modified)"
                + " VALUES (?, ?, ?, ?, 'tenant', ?, ?, 'SESSION', ?, ?, 'SETTLED', ?, 'digest', '{}', 0, 1, 1)", operations);
        jdbc.batchUpdate("INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation, storage_id, display_name, config_ref, policy_ref,"
                + " state, workspace_kind, child_state, child_workspace_id, parent_workspace_id, parent_session_id, child_run_id, parent_cwd_relative)"
                + " VALUES ('tenant', ?, 1, 'storage', 'Child', 'config', 'policy', 'ACTIVE', 'CHILD_GIT', 'merged', ?, 'root', ?, ?, '.')", workspaces);
        jdbc.batchUpdate("INSERT INTO ma_resource (resource_key, session_scope_key, tenant_id, workspace_id, session_id, resource_id, kind, schema_version, byte_length, sha256, storage_kind, inline_bytes, state, gmt_create) VALUES (?, ?, 'tenant', 'root', ?, ?, 'managed-definition', 1, 2, ?, 'MYSQL_INLINE', X'7b7d', 'REFERENCED', " + ManagedSchemaTime.SQL_NOW + ")", resources);
        jdbc.batchUpdate("INSERT INTO ma_resource_ref (session_scope_key, owner_kind, owner_key, owner_revision, resource_key, tenant_id, workspace_id, session_id, resource_id, journal_revision, gmt_create) VALUES (?, 'JOURNAL', ?, 1, ?, 'tenant', 'root', ?, ?, 1, " + ManagedSchemaTime.SQL_NOW + ")", references);
    }

    private static void assertBounded(CapturingJdbc jdbc, Query query, String index, int limit) {
        assertThat(query).isNotNull();
        var plan = ExecutedQueryPlan.explain(jdbc, query.sql(), query.arguments());
        assertThat(plan.tableScan()).as(plan.text()).isFalse();
        if ("PRIMARY".equals(index) && plan.text().contains("Rows fetched before execution")) {
            var table = WorkspaceRecoveryStore.parse(jdbc.queryForObject("EXPLAIN FORMAT=JSON " + query.sql(), String.class, query.arguments()))
                    .path("query_block").path("table");
            assertThat(table.path("access_type").asText()).isEqualTo("const");
            assertThat(table.path("key").asText()).isEqualTo("PRIMARY");
            assertThat(table.path("rows_examined_per_scan").asInt()).isEqualTo(1);
        } else {
            assertThat(plan.usesIndex(index)).as(plan.text()).isTrue();
        }
        assertThat(plan.rowCounts()).as(plan.text()).isNotEmpty();
        assertThat(plan.preExecutionPageReads()).as(plan.text()).isLessThanOrEqualTo(limit);
        for (double count : plan.rowCounts()) {
            assertThat(count).as(plan.text()).isLessThanOrEqualTo(limit);
        }
    }

    private record Query(String sql, Object[] arguments) {}

    private static final class CapturingJdbc extends ManagedSchemaJdbcTemplate {
        private Query blocker;
        private Query due;
        private Query deleteIntent;
        private Query resource;
        private Query reference;

        private CapturingJdbc(DataSource source) {
            super(source);
        }

        @Override
        public <T> T queryForObject(String sql, Class<T> requiredType, Object... args) {
            if (sql.startsWith("SELECT COUNT(*) FROM ma_operation WHERE session_scope_key")) {
                blocker = new Query(sql, args.clone());
            }
            return super.queryForObject(sql, requiredType, args);
        }

        @Override
        public <T> List<T> query(String sql, RowMapper<T> mapper, Object... args) {
            if (sql.contains("WHERE o.delivery_state = 'PENDING'")) {
                due = new Query(sql, args.clone());
            }
            if (sql.contains(" FROM ma_resource WHERE resource_key")) {
                resource = new Query(sql, args.clone());
            }
            return super.query(sql, mapper, args);
        }

        @Override
        public <T> List<T> queryForList(String sql, Class<T> elementType, Object... args) {
            if (sql.startsWith("SELECT r.resource_key FROM ma_resource r JOIN")) {
                deleteIntent = new Query(sql, args.clone());
            }
            if (sql.startsWith("SELECT resource_key FROM ma_resource_ref")) {
                reference = new Query(sql, args.clone());
            }
            return super.queryForList(sql, elementType, args);
        }
    }
}
