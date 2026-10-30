package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.model.StoreModels;
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
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ManagedSnapshotNumericPagingTest {
    @Test
    void recentItemsKeepReadsBoundedAndPageBackwardInChronologicalOrder() {
        for (int count : List.of(1000, 10000)) {
            try (Fixture fixture = new Fixture(count, false)) {
                fixture.jdbc.bodyReads = 0;
                var page = fixture.backward(null, 2);
                assertThat(page.items()).extracting(StoreModels.ItemRecord::itemId)
                        .containsExactly(id(count - 1), id(count));
                assertThat(page.hasMore()).isTrue();
                assertThat(fixture.jdbc.bodyReads).isEqualTo(2);
                var older = fixture.backward(page.nextCursor(), 2);
                assertThat(older.items()).extracting(StoreModels.ItemRecord::itemId)
                        .containsExactly(id(count - 3), id(count - 2));
                assertThat(older.coveredSequence()).isEqualTo(page.coveredSequence());
                assertThat(fixture.jdbc.bodyReads).isEqualTo(4);
            }
        }
    }

    @Test
    void recentItemsCrossPagesAndTerminateWithoutDuplicates() {
        try (Fixture fixture = new Fixture(205, true)) {
            List<String> ids = new ArrayList<>();
            String cursor = null;
            do {
                var page = fixture.backward(cursor, 37);
                assertThat(page.items()).hasSizeLessThanOrEqualTo(37);
                ids.addAll(0, page.items().stream().map(StoreModels.ItemRecord::itemId).toList());
                cursor = page.nextCursor();
                assertThat(page.hasMore()).isEqualTo(cursor != null);
            } while (cursor != null);
            assertThat(ids).containsExactlyElementsOf(java.util.stream.IntStream.rangeClosed(1, 205)
                    .mapToObj(ManagedSnapshotNumericPagingTest::id).toList());
        }
    }

    @Test
    void messageCursorRejectsAnotherDirectionAndMalformedData() {
        try (Fixture fixture = new Fixture(205, false)) {
            var page = fixture.backward(null, 1);
            assertThatThrownBy(() -> fixture.forward(page.nextCursor(), 0, 1)).hasMessageContaining("cursor");
            var forward = fixture.forward(null, 0, 1);
            assertThatThrownBy(() -> fixture.backward(forward.nextCursor(), 1)).hasMessageContaining("cursor");
            assertThatThrownBy(() -> fixture.backward("not-a-message-cursor", 1)).hasMessageContaining("cursor");
        }
    }

    @Test
    void recentCursorExpiresWhenTheMessageProjectionIsRebuilt() {
        try (Fixture fixture = new Fixture(205, false)) {
            var first = fixture.backward(null, 2);
            fixture.transaction.executeWithoutResult(status -> {
                fixture.jdbc.update("UPDATE ma_message SET item_status='retracted'"
                        + " WHERE tenant_id=? AND session_id=? AND item_id=?", "tenant", "session", id(203));
                fixture.jdbc.update("UPDATE ma_event_stream SET projection_version=projection_version+1"
                        + " WHERE tenant_id=? AND session_id=? AND stream_kind='SESSION' AND stream_id=X''",
                        "tenant", "session");
                fixture.project();
            });
            assertThat(fixture.backward(null, 3).items().getFirst().status()).isEqualTo("retracted");
            assertThatThrownBy(() -> fixture.backward(first.nextCursor(), 2))
                    .isInstanceOfSatisfying(com.alibaba.qwen.code.managedagent.exception.ManagedAgentException.class,
                            error -> assertThat(error.getCode()).isEqualTo("message_projection_changed"));
        }
    }

    @Test
    void tenfoldHistoryKeepsInitialNumericPageReadsBounded() {
        List<Integer> reads = new ArrayList<>();
        for (int count : List.of(1000, 10000)) {
            try (Fixture fixture = new Fixture(count, false)) {
                fixture.jdbc.bodyReads = 0;
                var page = fixture.forward(null, count - 1, 1);
                assertThat(page.items())
                        .extracting(StoreModels.ItemRecord::itemId)
                        .containsExactly(id(count));
                assertThat(page.hasMore()).isFalse();
                reads.add(fixture.jdbc.bodyReads);
                assertThat(fixture.jdbc.directoryReads).isEqualTo(1);
                fixture.verifyDirectoryPlan();
            }
        }
        assertThat(reads).containsExactly(1, 1);
    }

    @Test
    void numericBoundarySkipsAllEqualSequencesAcrossPageBoundaries() {
        try (Fixture fixture = new Fixture(205, true)) {
            var ties = fixture.forward(null, 99, 2);
            assertThat(ties.items())
                    .extracting(StoreModels.ItemRecord::itemId)
                    .containsExactly(id(100), id(101));
            assertThat(ties.hasMore()).isTrue();
            var remainingTies =
                    fixture.forward(ties.nextCursor(), 0, 2);
            assertThat(remainingTies.items())
                    .extracting(StoreModels.ItemRecord::itemId)
                    .containsExactly(id(102), id(103));
            var afterTies = fixture.forward(null, 100, 2);
            assertThat(afterTies.items())
                    .extracting(StoreModels.ItemRecord::itemId)
                    .containsExactly(id(106), id(107));
            fixture.jdbc.bodyReads = 0;
            var empty = fixture.forward(null, 200, 2);
            assertThat(empty.items()).isEmpty();
            assertThat(empty.hasMore()).isFalse();
            assertThat(empty.nextCursor()).isNull();
            assertThat(empty.coveredSequence()).isEqualTo(ties.coveredSequence());
            assertThat(fixture.jdbc.bodyReads).isZero();
        }
    }

    @Test
    void numericFirstPageCursorExpiresAfterProjectionRebuild() {
        try (Fixture fixture = new Fixture(205, false)) {
            var first = fixture.forward(null, 199, 2);
            fixture.transaction.executeWithoutResult(status -> {
                fixture.jdbc.update("UPDATE ma_message SET item_status='retracted' WHERE tenant_id=? AND session_id=? AND item_id=?",
                        "tenant", "session", id(203));
                fixture.jdbc.update("UPDATE ma_event_stream SET projection_version=projection_version+1"
                        + " WHERE tenant_id=? AND session_id=? AND stream_kind='SESSION' AND stream_id=X''", "tenant", "session");
                fixture.project();
            });
            var changed = fixture.forward(null, 201, 2);
            assertThat(changed.items()).extracting(StoreModels.ItemRecord::itemId).containsExactly(id(202), id(203));
            assertThat(changed.items().getLast().status()).isEqualTo("retracted");
            assertThat(changed.coveredSequence()).isGreaterThan(first.coveredSequence());
            assertThatThrownBy(() -> fixture.forward(first.nextCursor(), 0, 2))
                    .isInstanceOfSatisfying(com.alibaba.qwen.code.managedagent.exception.ManagedAgentException.class,
                            error -> assertThat(error.getCode()).isEqualTo("message_projection_changed"));
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
            if (sql.startsWith("SELECT m.item_id, m.first_sequence,")) {
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
            transaction.setIsolationLevel(org.springframework.transaction.TransactionDefinition.ISOLATION_REPEATABLE_READ);
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
            String scope = ManagedSessionStore.sessionScopeKey("tenant", "session");
            byte[] bytes = {91, 93};
            for (int index = Math.max(1, count - 3); index <= count; index++) {
                String resourceId = "numeric-parts-" + index;
                String resourceKey = ManagedSessionStore.resourceKey(scope, resourceId);
                jdbc.update("INSERT INTO ma_resource(resource_key,session_scope_key,tenant_id,session_id,"
                                + "resource_id,kind,schema_version,byte_length,sha256,storage_kind,inline_bytes,state,gmt_create)"
                                + " VALUES(?,?,'tenant','session',?,'managed-message-parts',1,2,?,'MYSQL_INLINE',?,'REFERENCED',0)",
                        resourceKey, scope, resourceId, WorkspaceEvidenceResources.digest(bytes), bytes);
                jdbc.update("UPDATE ma_message SET body_resource_key=? WHERE item_id=?", resourceKey, id(index));
            }
            project();
        }

        StoreModels.MessagePage forward(String cursor, long afterSequence, int limit) {
            return transaction.execute(status -> store.findMessagePage("tenant", "session", cursor, limit, false, afterSequence));
        }

        StoreModels.MessagePage backward(String cursor, int limit) {
            return transaction.execute(status -> store.findMessagePage("tenant", "session", cursor, limit, true));
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
                    .contains("ix_ma_message_history")
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
