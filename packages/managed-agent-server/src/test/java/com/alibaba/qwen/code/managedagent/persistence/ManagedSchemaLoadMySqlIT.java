package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

class ManagedSchemaLoadMySqlIT extends ManagedSchemaSessionMySqlIT {
    @Test
    void tenfoldHistoryKeepsDueClaimsAndSnapshotBodyReadsBounded() {
        var session =
                jdbc.queryForMap(
                        "SELECT tenant_id, session_id FROM ma_session WHERE session_kind ="
                            + " 'PUBLIC'");
        String tenant = (String) session.get("tenant_id");
        String id = (String) session.get("session_id");
        tx.executeWithoutResult(
                status -> {
                    store.beginSessionRename(tenant, "load-rename", "digest", id, "renamed");
                    store.appendPublicEventIfAbsent(
                            tenant,
                            id,
                            "turn",
                            "item.output_text.delta",
                            Map.of("itemId", "item", "text", "snapshot"),
                            false,
                            UUID.randomUUID().toString());
                    store.materializeNextBatch(tenant, id, 100);
                });
        String resource =
                jdbc.queryForObject(
                        "SELECT manifest_resource_key FROM ma_snapshot WHERE tenant_id = ? AND"
                            + " session_id = ?",
                        String.class,
                        tenant,
                        id);
        seedHistory(tenant, id, 0, 1000);
        String due =
                "SELECT tenant_id, session_id, operation_id FROM ma_operation WHERE operation_kind"
                    + " = 'RENAME' AND delivery_state = 'PENDING' AND state = 'PENDING' AND"
                    + " available_at <= ? ORDER BY available_at LIMIT 100";
        String body =
                "SELECT inline_bytes, byte_length, sha256 FROM ma_resource WHERE resource_key = ?"
                        + " AND state = 'REFERENCED' AND deletion_operation_key IS NULL";
        var claims = scanned(due, Long.MAX_VALUE);
        assertThat(claims.scannedRows()).isPositive();
        var reads = scanned(body, resource);
        seedHistory(tenant, id, 1000, 10_000);
        assertThat(scanned(due, Long.MAX_VALUE).scannedRows()).isEqualTo(claims.scannedRows());
        assertThat(scanned(body, resource).scannedRows()).isEqualTo(reads.scannedRows());
        assertThat(store.deliverableRenames(Long.MAX_VALUE)).hasSize(1);
        assertThat(store.findSnapshotPage(tenant, id, null, 0, 10).items()).hasSize(1);
    }

    private ExecutedQueryPlan.Plan scanned(String sql, Object argument) {
        var plan = ExecutedQueryPlan.explain(jdbc, sql, argument);
        assertThat(plan.tableScan()).as(plan.text()).isFalse();
        assertThat(plan.scannedRows()).as(plan.text()).isBetween(0L, 10L);
        assertThat(plan.preExecutionPageReads()).as(plan.text()).isBetween(0L, 10L);
        assertThat(plan.scannedRows() > 0 || plan.preExecutionPageReads() > 0)
                .as("Actual row or optimization-stage page reads: %s", plan.text()).isTrue();
        return plan;
    }

    private void seedHistory(String tenant, String session, int first, int last) {
        String scope = ManagedSessionStore.sessionScopeKey(tenant, session);
        List<Object[]> operations = new ArrayList<>();
        List<Object[]> resources = new ArrayList<>();
        byte[] bytes = "history".getBytes(StandardCharsets.UTF_8);
        String digest = WorkspaceEvidenceResources.digest(bytes);
        for (int i = first; i < last; i++) {
            String identity = "history-" + i;
            operations.add(
                    new Object[] {
                        ManagedSchemaKeys.key(scope, identity),
                        scope,
                        scope,
                        identity,
                        tenant,
                        session,
                        ManagedSchemaKeys.key("SESSION", tenant, session),
                        "digest",
                        "{}",
                        1,
                        1
                    });
            resources.add(
                    new Object[] {
                        ManagedSchemaKeys.key(scope, identity),
                        scope,
                        tenant,
                        session,
                        identity,
                        bytes.length,
                        digest,
                        bytes,
                        identity
                    });
        }
        jdbc.batchUpdate(
                "INSERT INTO ma_operation (operation_key, scope_key, session_scope_key,"
                    + " operation_id, operation_kind, tenant_id, session_id, target_kind,"
                    + " target_key, request_digest, request_json, state, phase, delivery_state,"
                    + " gmt_create, gmt_modified) VALUES (?, ?, ?, ?, 'RENAME', ?, ?, 'SESSION', ?,"
                    + " ?, ?, 'COMPLETED', 'COMPLETED', 'COMPLETED', ?, ?)",
                operations);
        jdbc.batchUpdate(
                "INSERT INTO ma_resource (resource_key, session_scope_key, tenant_id, session_id, resource_id, kind, schema_version, byte_length, sha256, storage_kind, inline_bytes, publish_command_id, state, gmt_create) VALUES (?, ?, ?, ?, ?, 'managed-context', 1, ?, ?, 'MYSQL_INLINE', ?, ?, 'REFERENCED', " + ManagedSchemaTime.SQL_NOW + ")",
                resources);
    }
}
