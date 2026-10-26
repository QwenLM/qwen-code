package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationKind;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
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
            ManagedAgentStore store = new ManagedAgentStore(jdbc, new ObjectMapper(), Clock.systemUTC(),
                    ignored -> {}, new ManagedWorkspaceRegistry(jdbc), new ManagedAgentProperties());
            for (int i = 1; i <= 5; i++) {
                String id = "session-" + i;
                jdbc.update("INSERT INTO ma_session (tenant_id,session_id,agent_id,status,gmt_create,gmt_modified,"
                                + "tenant_key,session_key,session_scope_key) VALUES (?,?,?,?,?,0,?,?,?)",
                        "tenant", id, "qwen-code", i % 2 == 0 ? "ARCHIVED" : "ACTIVE", i,
                        ManagedSchemaKeys.key("tenant"), ManagedSchemaKeys.key(id),
                        ManagedSessionStore.sessionScopeKey("tenant", id));
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
        }
    }
}
