package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.time.Clock;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class ManagedSnapshotNumericPagingTest {
    @Test
    void tenfoldHistoryKeepsInitialNumericPageReadsBounded() {
        List<Integer> reads = new ArrayList<>();
        for (int count : List.of(1000, 10000)) {
            try (Fixture fixture = new Fixture(count, false)) {
                fixture.jdbc.bodyReads = 0;
                var page = fixture.store.findSnapshotPage("tenant", "session", null, count - 1, 1);
                assertThat(page.items())
                        .extracting(StoreModels.ItemRecord::itemId)
                        .containsExactly(id(count));
                assertThat(page.hasMore()).isFalse();
                reads.add(fixture.jdbc.bodyReads);
                assertThat(fixture.jdbc.directoryReads).isEqualTo(1);
                fixture.verifyDirectoryPlan();
            }
        }
        assertThat(reads).containsExactly(2, 2);
    }

    @Test
    void numericBoundarySkipsAllEqualSequencesAcrossPageBoundaries() {
        try (Fixture fixture = new Fixture(205, true)) {
            var ties = fixture.store.findSnapshotPage("tenant", "session", null, 99, 2);
            assertThat(ties.items())
                    .extracting(StoreModels.ItemRecord::itemId)
                    .containsExactly(id(100), id(101));
            assertThat(ties.hasMore()).isTrue();
            var remainingTies =
                    fixture.store.findSnapshotPage("tenant", "session", ties.nextCursor(), 0, 2);
            assertThat(remainingTies.items())
                    .extracting(StoreModels.ItemRecord::itemId)
                    .containsExactly(id(102), id(103));
            var afterTies = fixture.store.findSnapshotPage("tenant", "session", null, 100, 2);
            assertThat(afterTies.items())
                    .extracting(StoreModels.ItemRecord::itemId)
                    .containsExactly(id(106), id(107));
            fixture.jdbc.bodyReads = 0;
            var empty = fixture.store.findSnapshotPage("tenant", "session", null, 200, 2);
            assertThat(empty.items()).isEmpty();
            assertThat(empty.hasMore()).isFalse();
            assertThat(empty.nextCursor()).isNull();
            assertThat(empty.coveredSequence()).isEqualTo(ties.coveredSequence());
            assertThat(fixture.jdbc.bodyReads).isEqualTo(1);
        }
    }

    @Test
    void numericFirstPageCursorRetainsOriginalSnapshotAfterProjectionChanges() {
        try (Fixture fixture = new Fixture(205, false)) {
            var first = fixture.store.findSnapshotPage("tenant", "session", null, 199, 2);
            fixture.transaction.executeWithoutResult(
                    status -> {
                        fixture.jdbc.update(
                                "UPDATE ma_message SET item_status='retracted' WHERE tenant_id=?"
                                        + " AND session_id=? AND item_id=?",
                                "tenant",
                                "session",
                                id(203));
                        fixture.jdbc.update(
                                "UPDATE ma_event_stream SET projection_version=projection_version+1"
                                        + " WHERE tenant_id=? AND session_id=? AND"
                                        + " stream_kind='SESSION' AND stream_id=X''",
                                "tenant",
                                "session");
                        fixture.project();
                    });
            var changed = fixture.store.findSnapshotPage("tenant", "session", null, 201, 2);
            assertThat(changed.items())
                    .extracting(StoreModels.ItemRecord::itemId)
                    .containsExactly(id(202), id(203));
            assertThat(changed.items().getLast().status()).isEqualTo("retracted");
            assertThat(changed.coveredSequence()).isGreaterThan(first.coveredSequence());
            var next =
                    fixture.store.findSnapshotPage("tenant", "session", first.nextCursor(), 0, 2);
            assertThat(next.items())
                    .extracting(StoreModels.ItemRecord::itemId)
                    .containsExactly(id(202), id(203));
            assertThat(next.items().getLast().status()).isEqualTo("completed");
            assertThat(next.coveredSequence()).isEqualTo(first.coveredSequence());
        }
    }

    private static String id(int value) {
        return "item" + String.format("%06d", value);
    }

    private static final class CountingJdbc extends ManagedSchemaJdbcTemplate {
        private int bodyReads;
        private int directoryReads;
        private String directorySql;
        private Object[] directoryArguments;

        CountingJdbc(DataSource source) {
            super(source);
        }

        @Override
        public <T> List<T> query(String sql, RowMapper<T> mapper, Object... args) {
            if (sql.contains("FROM ma_resource WHERE") && sql.contains("inline_bytes")) {
                bodyReads++;
            }
            if (sql.startsWith("SELECT snapshot_page_ordinal FROM ma_resource")) {
                directoryReads++;
                directorySql = sql;
                directoryArguments = args.clone();
            }
            return super.query(sql, mapper, args);
        }
    }

    private static final class Fixture implements AutoCloseable {
        private final ConsolidatedStoreFixture database;
        private final CountingJdbc jdbc;
        private final ManagedAgentStore store;
        private final TransactionTemplate transaction;
        private int projection;

        Fixture(int count, boolean ties) {
            database = ConsolidatedStoreFixture.open("snapshot_numeric");
            ManagedSchema.initialize(database.source());
            jdbc = new CountingJdbc(database.source());
            transaction =
                    new TransactionTemplate(new DataSourceTransactionManager(database.source()));
            store =
                    new ManagedAgentStore(
                            jdbc,
                            new ObjectMapper(),
                            Clock.systemUTC(),
                            ignored -> {},
                            new ManagedWorkspaceRegistry(jdbc),
                            new ManagedAgentProperties());
            jdbc.update(
                    "INSERT INTO"
                        + " ma_session(tenant_id,session_id,agent_id,gmt_create,gmt_modified,tenant_key,session_key,session_scope_key)"
                        + " VALUES(?,?,?,0,0,?,?,?)",
                    "tenant",
                    "session",
                    "qwen-code",
                    ManagedSchemaKeys.key("tenant"),
                    ManagedSchemaKeys.key("session"),
                    ManagedSessionStore.sessionScopeKey("tenant", "session"));
            int sequence = ties ? count - 5 : count;
            jdbc.update(
                    "INSERT INTO"
                        + " ma_event_stream(tenant_id,session_id,stream_kind,stream_id,last_sequence,covered_sequence,gmt_modified)"
                        + " VALUES(?,?,'SESSION',?,?,?,0)",
                    "tenant",
                    "session",
                    "",
                    sequence,
                    sequence);
            List<Object[]> rows = new ArrayList<>();
            for (int i = 1; i <= count; i++) {
                int first = ties && i >= 100 ? i <= 105 ? 100 : i - 5 : i;
                rows.add(new Object[] {"tenant", "session", id(i), "turn", first, first});
            }
            jdbc.batchUpdate(
                    "INSERT INTO"
                        + " ma_message(tenant_id,session_id,item_id,turn_id,item_type,item_role,item_status,attributes_json,"
                        + "first_sequence,last_sequence,gmt_create,gmt_modified,revision,parts_json)"
                        + " VALUES(?,?,?,?,'message','assistant','completed','{}',?,?,0,0,1,'[]')",
                    rows);
            project();
        }

        void project() {
            transaction.executeWithoutResult(
                    status -> {
                        store.appendPublicEventIfAbsent(
                                "tenant",
                                "session",
                                null,
                                "session.metadata.updated",
                                Map.of("title", "projection"),
                                false,
                                "projection-" + ++projection);
                        store.materializeNextBatch("tenant", "session", 100);
                    });
        }

        void verifyDirectoryPlan() {
            if (System.getProperty("managed.schema.mysql.port") == null) {
                return;
            }
            String plan =
                    jdbc.queryForObject(
                            "EXPLAIN ANALYZE " + jdbc.directorySql,
                            String.class,
                            jdbc.directoryArguments);
            assertThat(plan)
                    .contains("ix_ma_snapshot_page_lookup")
                    .doesNotContain("Table scan", "Sort:");
            var counts =
                    java.util.regex.Pattern.compile(
                                    "actual time=[^)]*?rows=([0-9.]+) loops=([0-9]+)")
                            .matcher(plan);
            long rows = 0;
            while (counts.find()) {
                rows +=
                        Math.round(
                                Double.parseDouble(counts.group(1))
                                        * Long.parseLong(counts.group(2)));
            }
            assertThat(rows).as(plan).isPositive().isLessThanOrEqualTo(4);
        }

        @Override
        public void close() {
            database.close();
        }
    }
}
