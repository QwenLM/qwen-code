package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationKind;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.Clock;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class ManagedSessionHistoryTest {
    @Test
    void filtersBeforeKeysetPaginationAndBatchesLatestLifecycleOperations() {
        try (var fixture = ConsolidatedStoreFixture.open("session_history")) {
            ManagedSchema.initialize(fixture.source());
            JdbcTemplate jdbc = new JdbcTemplate(fixture.source());
            ManagedAgentStore store = com.alibaba.qwen.code.managedagent.VerificationFixtures.managedAgentStore(jdbc, new ObjectMapper(), Clock.systemUTC(),
                    ignored -> {}, new JdbcManagedWorkspaceRegistry(jdbc), new ManagedAgentProperties(), new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules());
            for (int i = 1; i <= 5; i++) {
                String id = "session-" + i;
                jdbc.update("INSERT INTO ma_session (tenant_id,session_id,agent_id,status,gmt_create,gmt_modified)"
                                + " VALUES (?,?,?,?,?,0)",
                        "tenant", id, "qwen-code", i % 2 == 0 ? "ARCHIVED" : "ACTIVE", i);
                jdbc.update("INSERT INTO ma_event_stream (tenant_id, session_id, stream_kind, stream_id, gmt_modified)"
                        + " VALUES (?, ?, 'SESSION', X'', 0)", "tenant", id);
            }
            var first = store.listSessions("tenant", null, null, null, 1, "archived");
            assertThat(first.sessions()).extracting(row -> row.sessionId()).containsExactly("session-4");
            assertThat(first.hasMore()).isTrue();
            var next = store.listSessions("tenant", null, 4L, "session-4", 1, "archived");
            assertThat(next.sessions()).extracting(row -> row.sessionId()).containsExactly("session-2");
            assertThat(next.hasMore()).isFalse();
            assertThat(store.listSessions("tenant", null, null, null, 100, "unarchived").sessions()).hasSize(3);
            assertThat(store.listSessions("tenant", null, null, null, 100).sessions()).hasSize(5);
            var close = store.beginOperation("tenant", "session-1", OperationKind.CLOSE, "", "close", "digest");
            jdbc.update("UPDATE ma_operation SET state='FAILED', failure_code='fixture', gmt_create=0 WHERE operation_id=?",
                    close.operation().operationId());
            var operations = store.findLatestLifecycleOperations("tenant", List.of("session-1", "session-3"));
            assertThat(operations).hasSize(1);
            assertThat(operations.get("session-1").operationId()).isEqualTo(close.operation().operationId());
            assertThat(operations.get("session-1").failureCode()).isEqualTo("fixture");
            assertThat(operations.get("session-1").status()).isEqualTo("failed");
            assertThat(store.findLatestLifecycleOperations("other", List.of("session-1"))).isEmpty();
            jdbc.update("UPDATE ma_session SET status='CLOSED' WHERE tenant_id=? AND session_id=?", "tenant", "session-1");
            var archived = store.beginOperation("tenant", "session-1", OperationKind.ARCHIVE, "", "archive", "digest-archive");
            assertThat(archived.operation().state()).isEqualTo("COMPLETED");
            assertThat(store.findLatestLifecycleOperations("tenant", List.of("session-1"))).isEmpty();
            var delete = store.beginOperation("tenant", "session-1", OperationKind.DELETE, "", "delete", "digest-delete");
            jdbc.update("UPDATE ma_operation SET state='FAILED', gmt_create=0 WHERE operation_id=?",
                    delete.operation().operationId());
            assertThat(store.findLatestLifecycleOperations("tenant", List.of("session-1")).get("session-1").operationId())
                    .isEqualTo(delete.operation().operationId());
            assertThat(jdbc.queryForList("SELECT session_id FROM ma_operation"
                            + " WHERE operation_kind IN ('CLOSE', 'ARCHIVE', 'DELETE')", String.class))
                    .hasSize(3).containsOnly("session-1");
        }
    }

    @Test
    void lifecycleWindowKeepsActivePriorityTieBreakersAndTenantSessionScope() {
        try (var fixture = ConsolidatedStoreFixture.open("lifecycle_window")) {
            ManagedSchema.initialize(fixture.source());
            JdbcTemplate jdbc = new ManagedSchemaJdbcTemplate(fixture.source());
            ManagedAgentStore store = com.alibaba.qwen.code.managedagent.VerificationFixtures.managedAgentStore(jdbc, new ObjectMapper(), Clock.systemUTC(),
                    ignored -> {}, new JdbcManagedWorkspaceRegistry(jdbc), new ManagedAgentProperties(), new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules());
            seedSession(jdbc, "tenant", "close", "CLOSING", "PUBLIC");
            seedSession(jdbc, "tenant", "delete", "DELETING", "PUBLIC");
            seedSession(jdbc, "tenant", "archive", "ARCHIVING", "PUBLIC");
            seedSession(jdbc, "tenant", "active", "ACTIVE", "PUBLIC");
            seedSession(jdbc, "tenant", "unrequested", "CLOSING", "PUBLIC");
            // PUBLIC IDs are globally unique; a CONTROL row can reuse one in another tenant.
            seedSession(jdbc, "other", "close", "CLOSING", "CONTROL");
            seedOperation(jdbc, "tenant", "close", "close-terminal", "CLOSE", "FAILED", 900, 900);
            seedOperation(jdbc, "tenant", "close", "close-early", "CLOSE", "PENDING", 90, 100);
            seedOperation(jdbc, "tenant", "close", "close-z", "CLOSE", "RUNNING", 50, 200);
            seedOperation(jdbc, "tenant", "close", "close-a", "CLOSE", "RECOVERY_BLOCKED", 80, 200);
            seedOperation(jdbc, "tenant", "close", "close-b", "CLOSE", "PENDING", 80, 200);
            seedOperation(jdbc, "tenant", "close", "wrong-kind", "DELETE", "RUNNING", 1000, 1000);
            seedOperation(jdbc, "tenant", "delete", "delete-old", "DELETE", "COMPLETED", 10, 10);
            seedOperation(jdbc, "tenant", "delete", "delete-failed", "DELETE", "FAILED", 20, 20);
            seedOperation(jdbc, "tenant", "delete", "delete-wrong-kind", "CLOSE", "RUNNING", 1000, 1000);
            seedOperation(jdbc, "tenant", "archive", "archive-blocked", "ARCHIVE", "RECOVERY_BLOCKED", 30, 30);
            seedOperation(jdbc, "tenant", "active", "active-close", "CLOSE", "PENDING", 40, 40);
            seedOperation(jdbc, "tenant", "unrequested", "unrequested-close", "CLOSE", "PENDING", 50, 50);
            seedOperation(jdbc, "other", "close", "other-close", "CLOSE", "RUNNING", 2000, 2000);

            var operations = store.findLatestLifecycleOperations("tenant", List.of("close", "delete", "archive", "active"));
            assertThat(operations).containsOnlyKeys("close", "delete", "archive");
            assertThat(operations.get("close").operationId()).isEqualTo("close-b");
            assertThat(operations.get("close").status()).isEqualTo("pending");
            assertThat(operations.get("delete").operationId()).isEqualTo("delete-failed");
            assertThat(operations.get("delete").failureCode()).isEqualTo("fixture");
            assertThat(operations.get("archive").type()).isEqualTo("archive");
            assertThat(operations.get("archive").status()).isEqualTo("recovery_blocked");
            jdbc.update("UPDATE ma_operation SET state = 'FAILED' WHERE operation_id = ?", "close-b");
            assertThat(store.findLatestLifecycleOperations("tenant", List.of("close")).get("close").operationId())
                    .isEqualTo("close-a");
            jdbc.update("UPDATE ma_operation SET state = 'FAILED' WHERE operation_id = ?", "close-a");
            assertThat(store.findLatestLifecycleOperations("tenant", List.of("close")).get("close").operationId())
                    .isEqualTo("close-z");
            assertThat(store.findLatestLifecycleOperations("other", List.of("close")).get("close").operationId())
                    .isEqualTo("other-close");
            assertThat(store.findLatestLifecycleOperations("tenant", List.of())).isEmpty();
        }
    }

    private void seedSession(JdbcTemplate jdbc, String tenant, String session, String status, String kind) {
        jdbc.update("INSERT INTO ma_session (tenant_id, session_id, agent_id, status, gmt_create, gmt_modified,"
                        + " session_kind) VALUES (?, ?, 'qwen-code', ?, 0, 0, ?)",
                tenant, session, status, kind);
    }

    private void seedOperation(JdbcTemplate jdbc, String tenant, String session, String id,
            String kind, String state, long created, long modified) {
        jdbc.update("INSERT INTO ma_operation (operation_ref, scope_kind, scope_id, tenant_id, session_id,"
                        + " operation_id, operation_kind, target_kind, target_id, request_digest, request_json,"
                        + " state, phase, failure_code, gmt_create, gmt_modified)"
                        + " VALUES (?, 'SESSION', ?, ?, ?, ?, ?, 'SESSION', ?, 'digest', '{}', ?, ?, ?, ?, ?)",
                AgentStoreRows.sessionOperationKey(tenant, session, OperationKind.valueOf(kind), id),
                session, tenant, session, id, kind,
                session, state, state, "FAILED".equals(state) ? "fixture" : null, created, modified);
    }
}
