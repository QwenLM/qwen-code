package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.StoreModels;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.time.Clock;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ManagedMessagePagingTest {
    private CountingJdbc jdbc;
    private ManagedAgentStore store;
    private TransactionTemplate view;

    protected DataSource dataSource() {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:message-pages-" + UUID.randomUUID()
                + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1");
        return source;
    }

    @BeforeEach
    void setup() {
        DataSource source = dataSource();
        ManagedSchema.initialize(source);
        jdbc = new CountingJdbc(source);
        store = new ManagedAgentStore(jdbc, new ObjectMapper(), Clock.systemUTC(), ignored -> {},
                new ManagedWorkspaceRegistry(jdbc), new ManagedAgentProperties());
        view = new TransactionTemplate(new DataSourceTransactionManager(source));
        view.setReadOnly(true);
        view.setIsolationLevel(TransactionDefinition.ISOLATION_REPEATABLE_READ);
        jdbc.update("INSERT INTO ma_session(tenant_id,session_id,agent_id,gmt_create,gmt_modified,"
                        + "tenant_key,session_key,session_scope_key) VALUES(?,?,?,0,0,?,?,?)",
                "tenant", "session", "qwen-code", ManagedSchemaKeys.key("tenant"),
                ManagedSchemaKeys.key("session"), ManagedSessionStore.sessionScopeKey("tenant", "session"));
        jdbc.update("INSERT INTO ma_event_stream(tenant_id,session_id,stream_kind,stream_id,"
                + "last_sequence,covered_sequence,gmt_modified) VALUES(?,?,'SESSION',X'',0,0,0)", "tenant", "session");
    }

    private void seed(int count, boolean ties) {
        List<Object[]> rows = new ArrayList<>();
        for (int index = 1; index <= count; index++) {
            long sequence = ties ? (index + 1L) / 2 : index;
            rows.add(new Object[] {"tenant", "session", id(index), "turn", sequence, sequence});
        }
        jdbc.batchUpdate("INSERT INTO ma_message(tenant_id,session_id,item_id,turn_id,item_type,item_role,"
                + "item_status,attributes_json,first_sequence,last_sequence,gmt_create,gmt_modified,parts_json)"
                + " VALUES(?,?,?,?,'message','assistant','completed','{}',?,?,0,0,'[]')", rows);
        progress(count);
    }

    private void progress(long sequence) {
        jdbc.update("UPDATE ma_event_stream SET covered_sequence=?,last_sequence=? WHERE tenant_id=?"
                + " AND session_id=? AND stream_kind='SESSION' AND stream_id=X''", sequence, sequence, "tenant", "session");
    }

    private StoreModels.MessagePage read(String cursor, int limit, boolean backward) {
        return view.execute(status -> store.findMessagePage("tenant", "session", cursor, limit, backward));
    }

    @Test
    void latestPageReadsOnlySelectedMessagesWithoutAnySnapshot() {
        seed(10000, false);
        var page = read(null, 2, true);
        assertThat(page.items()).extracting(StoreModels.ItemRecord::itemId).containsExactly(id(9999), id(10000));
        assertThat(page.hasMore()).isTrue();
        assertThat(jdbc.messageReads).isEqualTo(2);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource", Long.class)).isZero();
        var older = read(page.nextCursor(), 2, true);
        assertThat(older.items()).extracting(StoreModels.ItemRecord::itemId).containsExactly(id(9997), id(9998));
        assertThat(jdbc.messageReads).isEqualTo(4);
    }

    @Test
    void fullTupleCursorPagesTiesWithoutDuplicatesInBothDirections() {
        seed(205, true);
        for (boolean backward : List.of(true, false)) {
            List<String> ids = new ArrayList<>();
            String cursor = null;
            do {
                var page = read(cursor, 7, backward);
                assertThat(page.items()).hasSizeLessThanOrEqualTo(7);
                var next = page.items().stream().map(StoreModels.ItemRecord::itemId).toList();
                ids.addAll(backward ? 0 : ids.size(), next);
                assertThat(page.hasMore()).isEqualTo(page.nextCursor() != null);
                cursor = page.nextCursor();
            } while (cursor != null);
            assertThat(ids).containsExactlyElementsOf(java.util.stream.IntStream.rangeClosed(1, 205)
                    .mapToObj(ManagedMessagePagingTest::id).toList());
        }
    }

    @Test
    void streamHandoffUsesProjectionProgressRatherThanUnprojectedHead() {
        seed(2, false);
        jdbc.update("UPDATE ma_event_stream SET last_sequence=20 WHERE tenant_id=? AND session_id=?",
                "tenant", "session");
        assertThat(read(null, 100, true).coveredSequence()).isEqualTo(2);
        assertThatThrownBy(() -> read(null, 100, false))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
                    assertThat(error.getCode()).isEqualTo("message_projection_pending");
                }).hasMessageContaining("pending messages");
    }

    @Test
    void refusesAProjectionBelowTheReplayFloorRatherThanSkippingHistory() {
        seed(2, false);
        jdbc.update("UPDATE ma_event_stream SET last_sequence=20,replay_floor_sequence=10"
                + " WHERE tenant_id=? AND session_id=?", "tenant", "session");
        assertThatThrownBy(() -> read(null, 100, true))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
                    assertThat(error.getCode()).isEqualTo("message_projection_pending");
                }).hasMessageContaining("pending messages");
    }

    @Test
    void exportPinsMembershipButReadsUpdatedBodiesWithoutPublishingSnapshot() {
        seed(3, false);
        var first = read(null, 1, false);
        jdbc.update("UPDATE ma_message SET item_status='in_progress',last_sequence=4 WHERE item_id=?",
                id(2));
        jdbc.update("INSERT INTO ma_message(tenant_id,session_id,item_id,turn_id,item_type,item_status,attributes_json,"
                + "first_sequence,last_sequence,gmt_create,gmt_modified,parts_json)"
                + " VALUES(?, ?, ?, 'turn','message','completed','{}',4,4,0,0,'[]')", "tenant", "session", id(4));
        progress(4);
        var second = read(first.nextCursor(), 2, false);
        assertThat(second.items()).extracting(StoreModels.ItemRecord::itemId).containsExactly(id(2), id(3));
        assertThat(second.items().getFirst().status()).isEqualTo("in_progress");
        assertThat(second.items().getFirst().lastSequence()).isEqualTo(4);
        assertThat(second.throughSequence()).isEqualTo(3);
        assertThat(second.hasMore()).isFalse();
    }

    @Test
    void rejectsWrongScopeDirectionMalformedAndRebuiltCursors() {
        seed(3, false);
        String cursor = read(null, 1, true).nextCursor();
        assertThatThrownBy(() -> read(cursor, 1, false)).hasMessageContaining("cursor");
        assertThatThrownBy(() -> read("not-a-cursor", 1, true)).hasMessageContaining("cursor");
        String wrongScope = new String(java.util.Base64.getUrlDecoder().decode(cursor), java.nio.charset.StandardCharsets.UTF_8)
                .replace(ManagedSessionStore.sessionScopeKey("tenant", "session"), "other-scope");
        String changed = java.util.Base64.getUrlEncoder().withoutPadding()
                .encodeToString(wrongScope.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        assertThatThrownBy(() -> read(changed, 1, true)).hasMessageContaining("cursor");
        jdbc.update("UPDATE ma_event_stream SET projection_version=projection_version+1 WHERE tenant_id=? AND session_id=?",
                "tenant", "session");
        assertThatThrownBy(() -> read(cursor, 1, true)).hasMessageContaining("projection changed");
    }

    @Test
    void rejectsOversizedLookaheadBeforeLoadingBodyAndValidatesLimitsAndTenant() {
        seed(2, false);
        jdbc.update("UPDATE ma_message SET attributes_json=? WHERE item_id=?", "x".repeat(8 * 1024 * 1024 + 1), id(2));
        assertThatThrownBy(() -> read(null, 2, true)).hasMessageContaining("byte budget");
        assertThat(jdbc.messageReads).isZero();
        assertThatThrownBy(() -> read(null, 0, true)).hasMessageContaining("Limit");
        assertThatThrownBy(() -> read(null, 101, true)).hasMessageContaining("Limit");
        assertThatThrownBy(() -> view.execute(status -> store.findMessagePage("other", "session", null, 2, true)))
                .hasMessageContaining("not found");
    }

    @Test
    void loadsSelectedResourcePartsWithTheirExistingScopeAndDigestChecks() throws Exception {
        seed(1, false);
        byte[] bytes = new ObjectMapper().writeValueAsBytes(List.of(
                new StoreModels.ItemPartRecord("text", "text", "resource body", 1, 1, 0, 0, 1)));
        String resource = resource(bytes);
        assertThat(read(null, 1, true).items().getFirst().content())
                .extracting(StoreModels.ItemPartRecord::text).containsExactly("resource body");
        jdbc.update("UPDATE ma_resource SET sha256=? WHERE resource_key=?", "0".repeat(64), resource);
        assertThatThrownBy(() -> read(null, 1, true)).hasMessageContaining("digest differs");
        jdbc.update("UPDATE ma_resource SET sha256=?,session_scope_key=? WHERE resource_key=?",
                WorkspaceEvidenceResources.digest(bytes), ManagedSessionStore.sessionScopeKey("other", "session"), resource);
        assertThatThrownBy(() -> read(null, 1, true)).hasMessageContaining("unavailable");
    }

    @Test
    void budgetsActualResourceBytesBeforeLoadingASelectedBody() {
        seed(1, false);
        String resource = resource(new byte[8 * 1024 * 1024 + 1]);
        jdbc.update("UPDATE ma_resource SET byte_length=1 WHERE resource_key=?", resource);
        assertThatThrownBy(() -> read(null, 1, true)).hasMessageContaining("byte budget");
        assertThat(jdbc.messageReads).isZero();
    }

    private String resource(byte[] bytes) {
        String scope = ManagedSessionStore.sessionScopeKey("tenant", "session");
        String key = ManagedSessionStore.resourceKey(scope, "page-parts");
        jdbc.update("INSERT INTO ma_resource(resource_key,session_scope_key,tenant_id,session_id,resource_id,"
                        + "kind,schema_version,byte_length,sha256,storage_kind,inline_bytes,state,gmt_create,last_verified_at)"
                        + " VALUES(?,?,?,?,'page-parts','managed-message-parts',1,?,?,'MYSQL_INLINE',?,'REFERENCED',0,0)",
                key, scope, "tenant", "session", bytes.length, WorkspaceEvidenceResources.digest(bytes), bytes);
        jdbc.update("UPDATE ma_message SET body_resource_key=? WHERE item_id=?", key, id(1));
        return key;
    }

    @Test
    void refusesPrivateCsiSessionsWithoutBorrowingTheirJournalAsMessages() {
        seed(2, false);
        jdbc.update("UPDATE ma_session SET tool_profile='csi-files-retirement/1' WHERE tenant_id=? AND session_id=?",
                "tenant", "session");
        assertThatThrownBy(() -> read(null, 1, true)).hasMessageContaining("private CSI");
    }

    @Test
    void includesOnlyLatestControlStatesOfTheSelectedTurns() {
        seed(3, false);
        jdbc.update("INSERT INTO ma_public_event(tenant_id,session_id,sequence_id,event_id,turn_id,event_type,data_json,"
                + "terminal,gmt_create) VALUES(?,?,3,'terminal','turn','turn.completed','{}',TRUE,0)", "tenant", "session");
        var page = read(null, 1, true);
        assertThat(page.events()).extracting(StoreModels.EventRecord::type).containsExactly("turn.completed");
        assertThat(page.events().getFirst().sequence()).isEqualTo(3);
    }

    private static String id(int value) {
        return "item" + String.format("%06d", value);
    }

    private static final class CountingJdbc extends ManagedSchemaJdbcTemplate {
        private int messageReads;

        private CountingJdbc(DataSource source) {
            super(source);
        }

        @Override
        public <T> List<T> query(String sql, RowMapper<T> mapper, Object... args) {
            return super.query(sql, (row, index) -> {
                if (sql.contains("FROM ma_message WHERE")) {
                    messageReads++;
                }
                return mapper.mapRow(row, index);
            }, args);
        }
    }
}
