package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;

import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

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
        long claims = scanned(due, Long.MAX_VALUE);
        long reads = scanned(body, resource);
        seedHistory(tenant, id, 1000, 10_000);
        assertThat(scanned(due, Long.MAX_VALUE)).isEqualTo(claims);
        assertThat(scanned(body, resource)).isEqualTo(reads);
        assertThat(store.deliverableRenames(Long.MAX_VALUE)).hasSize(1);
        assertThat(store.findSnapshotPage(tenant, id, null, 0, 10).items()).hasSize(1);
    }

    private long scanned(String sql, Object argument) {
        String plan = jdbc.queryForObject("EXPLAIN ANALYZE " + sql, String.class, argument);
        assertThat(plan).doesNotContain("Table scan");
        var counts =
                java.util.regex.Pattern.compile("actual time=[^)]*?rows=([0-9.]+) loops=([0-9]+)")
                        .matcher(plan);
        long scanned = 0;
        while (counts.find()) {
            scanned +=
                    Math.round(
                            Double.parseDouble(counts.group(1)) * Long.parseLong(counts.group(2)));
        }
        assertThat(scanned).as(plan).isPositive().isLessThanOrEqualTo(10);
        return scanned;
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
                    + " created_at, updated_at) VALUES (?, ?, ?, ?, 'RENAME', ?, ?, 'SESSION', ?,"
                    + " ?, ?, 'COMPLETED', 'COMPLETED', 'COMPLETED', ?, ?)",
                operations);
        jdbc.batchUpdate(
                "INSERT INTO ma_resource (resource_key, session_scope_key, tenant_id, session_id,"
                    + " resource_id, kind, schema_version, byte_length, sha256, storage_kind,"
                    + " inline_bytes, publish_command_id, state, created_at) VALUES (?, ?, ?, ?, ?,"
                    + " 'managed-context', 1, ?, ?, 'MYSQL_INLINE', ?, ?, 'REFERENCED',"
                    + " CURRENT_TIMESTAMP(6))",
                resources);
    }
}
