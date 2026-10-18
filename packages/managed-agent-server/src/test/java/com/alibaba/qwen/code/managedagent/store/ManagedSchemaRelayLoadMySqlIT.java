package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;

import javax.sql.DataSource;

import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class ManagedSchemaRelayLoadMySqlIT {
    @Test
    void tenfoldAcceptedHistoryDoesNotIncreaseMessageHandoverScans() {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase()) {
            ManagedSchema.initialize(database.source());
            var jdbc = new QueryRecorder(database.source());
            var relay = new SessionMessageRelayStore(jdbc);
            for (String state : List.of("planned", "accepting", "unknown")) {
                record(jdbc, "session_message", "pending-" + state, state, 20_000);
            }
            long previousScan = -1;
            int first = 0;
            for (int history : List.of(1000, 10_000)) {
                history(jdbc, "session_message", "accepted", first, history);
                jdbc.recorded.clear();
                assertThat(relay.findPendingMessages("worker", 30_000, 50))
                        .extracting(SessionMessageRelayStore.PendingMessage::messageId)
                        .containsExactly("pending-accepting", "pending-planned", "pending-unknown");
                var plan = explain(database.source(), jdbc.recorded.getFirst());
                assertThat(plan.usesIndex("ix_ma_record_delivery")).as(plan.text()).isTrue();
                long scanned = plan.scannedRows();
                assertThat(scanned).as(plan.text()).isPositive().isLessThanOrEqualTo(30);
                if (previousScan >= 0) {
                    assertThat(scanned).as(plan.text()).isEqualTo(previousScan);
                }
                previousScan = scanned;
                first = history;
            }
        }
    }

    @Test
    void tenfoldDeliveredHistoryDoesNotIncreaseChannelDeliveryScans() {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase()) {
            ManagedSchema.initialize(database.source());
            var jdbc = new QueryRecorder(database.source());
            var channels = new ChannelInstanceStore(jdbc);
            record(jdbc, "channel_delivery", "pending", "planned", 20_000);
            long previousScan = -1;
            int first = 0;
            for (int history : List.of(1000, 10_000)) {
                history(jdbc, "channel_delivery", "delivered", first, history);
                jdbc.recorded.clear();
                assertThat(channels.findPendingDeliveries("tenant", "sender", 50))
                        .extracting(ChannelInstanceStore.PendingDelivery::deliveryId).containsExactly("pending");
                var plan = explain(database.source(), jdbc.recorded.getFirst());
                assertThat(plan.usesIndex("ix_ma_record_session_delivery")).as(plan.text()).isTrue();
                long scanned = plan.scannedRows();
                assertThat(scanned).as(plan.text()).isPositive().isLessThanOrEqualTo(10);
                if (previousScan >= 0) {
                    assertThat(scanned).as(plan.text()).isEqualTo(previousScan);
                }
                previousScan = scanned;
                first = history;
            }
        }
    }

    private static ExecutedQueryPlan.Plan explain(DataSource source, Statement statement) {
        return ExecutedQueryPlan.explain(new JdbcTemplate(source), statement.sql(), statement.arguments());
    }

    private static void record(JdbcTemplate jdbc, String domain, String id, String state, long createdAt) {
        jdbc.update(INSERT, row(domain, id, state, createdAt));
    }

    private static void history(JdbcTemplate jdbc, String domain, String state, int first, int last) {
        List<Object[]> rows = new ArrayList<>();
        for (int index = first; index < last; index++) {
            rows.add(row(domain, "history-" + index, state, index));
        }
        jdbc.batchUpdate(INSERT, rows);
    }

    private static Object[] row(String domain, String id, String state, long createdAt) {
        return new Object[] {ManagedSessionStore.sessionScopeKey("tenant", "sender"),
                ManagedSchemaKeys.key(domain, id), domain, id, state, createdAt};
    }

    private static final String INSERT = "INSERT INTO ma_session_record (session_scope_key, record_key, tenant_id,"
            + " workspace_id, session_id, domain, record_id, revision, record_resource_id, delivery_state, gmt_create)"
            + " VALUES (?, ?, 'tenant', 'workspace', 'sender', ?, ?, 1, 'resource', ?, ?)";

    private record Statement(String sql, Object[] arguments) {}

    private static final class QueryRecorder extends ManagedSchemaJdbcTemplate {
        private final List<Statement> recorded = new ArrayList<>();

        private QueryRecorder(DataSource source) {
            super(source);
        }

        @Override
        public <T> List<T> query(String sql, RowMapper<T> mapper, Object... arguments) {
            recorded.add(new Statement(sql, arguments.clone()));
            return super.query(sql, mapper, arguments);
        }
    }
}
