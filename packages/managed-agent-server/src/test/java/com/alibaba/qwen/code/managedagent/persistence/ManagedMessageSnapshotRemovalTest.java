package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.sql.Connection;
import java.sql.SQLException;
import java.time.Clock;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

class ManagedMessageSnapshotRemovalTest {
    private static final String TENANT = "snapshot-removal-tenant";
    private final ObjectMapper json = new ObjectMapper();
    private JdbcTemplate jdbc;
    private TransactionTemplate transaction;
    private DataSourceTransactionManager manager;
    private Connection keepAlive;
    private ManagedAgentStore store;
    private String session;

    @BeforeEach
    void setup() throws SQLException {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:snapshot-removal-" + UUID.randomUUID()
                + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;LOCK_TIMEOUT=10000");
        keepAlive = source.getConnection();
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        manager = new DataSourceTransactionManager(source);
        transaction = new TransactionTemplate(manager);
        store = new ManagedAgentStore(jdbc, json, Clock.systemUTC(), ignored -> {},
                new ManagedWorkspaceRegistry(jdbc), new ManagedAgentProperties());
        session = transaction.execute(status -> store.insertSessionCommand(TENANT, "actor",
                "CREATE_SESSION", "create", "digest", "qwen-code", null, "title", List.of(), null))
                .sessionId();
    }

    @AfterEach
    void close() throws SQLException {
        keepAlive.close();
    }

    @Test
    void initializedSchemaOmitsOnlyPublicMessageSnapshotStorage() {
        assertThat(jdbc.queryForList("SELECT table_name FROM information_schema.tables"
                        + " WHERE table_schema = 'public'", String.class))
                .contains("ma_message", "ma_event_stream", "ma_resource", "ma_resource_ref",
                        "ma_session_head", "ma_session_journal_tx")
                .doesNotContain("ma_snapshot");
        assertThat(columns("ma_event_stream"))
                .contains("covered_sequence", "projection_version", "replay_floor_sequence")
                .doesNotContain("current_snapshot_id", "snapshot_stale_since");
        assertThat(columns("ma_resource"))
                .doesNotContain("snapshot_id", "snapshot_page_ordinal",
                        "snapshot_page_first_sequence", "snapshot_page_last_sequence");
        ManagedSchema.validate(jdbc.getDataSource());
    }

    @Test
    void materializationAndReplayCoverageWorkWithoutPersistedSnapshotCopies() throws Exception {
        event("message", "before");
        materialize();
        long covered = store.requireSession(TENANT, session).lastSequence();
        event("message", "after");
        long head = store.requireSession(TENANT, session).lastSequence();

        assertThat(head).isGreaterThan(covered);
        assertThat(store.findReplayWindow(TENANT, session).snapshotThroughSequence())
                .isEqualTo(covered);
        assertThat(store.findMessageCoveredSequences(TENANT, List.of(session)))
                .containsEntry(session, covered);

        materialize();
        assertThat(store.findReplayWindow(TENANT, session).snapshotThroughSequence()).isEqualTo(head);
        assertThat(store.findMessageCoveredSequences(TENANT, List.of(session)))
                .containsEntry(session, head);
        var parts = json.readTree(jdbc.queryForObject("SELECT parts_json FROM ma_message"
                + " WHERE tenant_id = ? AND session_id = ? AND item_id = ?",
                String.class, TENANT, session, "message"));
        assertThat(parts.get(0).path("text").asText()).isEqualTo("beforeafter");
        assertThat(new ManagedProjectionResourceCollector(jdbc, manager).runOnce()).isFalse();
        assertNoPublicSnapshotCopies();
    }

    @Test
    void collectorReclaimsReplacedMessageBodiesAndPreservesNativeSnapshotReferences() {
        event("large", "a".repeat(70_000));
        materialize();
        String oldBody = bodyKey();
        event("large", "b");
        materialize();
        String currentBody = bodyKey();
        assertThat(currentBody).isNotEqualTo(oldBody);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource_ref WHERE resource_key = ?",
                Long.class, oldBody)).isZero();

        String scope = ManagedSessionStore.sessionScopeKey(TENANT, session);
        String nativeId = "native-snapshot-manifest";
        String nativeKey = ManagedSessionStore.resourceKey(scope, nativeId);
        byte[] nativeBytes = {123, 125};
        jdbc.update("INSERT INTO ma_resource (resource_key, session_scope_key, tenant_id, session_id,"
                        + " resource_id, kind, schema_version, byte_length, sha256, storage_kind,"
                        + " inline_bytes, state, gmt_create, retention_until)"
                        + " VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, 'MYSQL_INLINE', ?, 'REFERENCED', 0, 0)",
                nativeKey, scope, TENANT, session, nativeId, ManagedNativeJournalSnapshots.MANIFEST_KIND,
                nativeBytes.length, ToolPublicationContract.sha256(nativeBytes), nativeBytes);
        jdbc.update("INSERT INTO ma_resource_ref (session_scope_key, owner_kind, owner_key,"
                        + " owner_revision, resource_key, tenant_id, session_id, resource_id, gmt_create)"
                        + " VALUES (?, 'NATIVE_SNAPSHOT', ?, 1, ?, ?, ?, ?, 0)",
                scope, ManagedSchemaKeys.key(scope, nativeId), nativeKey, TENANT, session, nativeId);
        jdbc.update("UPDATE ma_resource SET retention_until = 0 WHERE resource_key = ?", oldBody);

        assertThat(new ManagedProjectionResourceCollector(jdbc, manager).runOnce()).isTrue();
        assertThat(jdbc.queryForObject("SELECT state FROM ma_resource WHERE resource_key = ?",
                String.class, oldBody)).isEqualTo("COLLECTED");
        assertThat(jdbc.queryForObject("SELECT inline_bytes FROM ma_resource WHERE resource_key = ?",
                byte[].class, oldBody)).isNull();
        assertThat(jdbc.queryForObject("SELECT state FROM ma_resource WHERE resource_key = ?",
                String.class, currentBody)).isEqualTo("REFERENCED");
        assertThat(jdbc.queryForObject("SELECT inline_bytes FROM ma_resource WHERE resource_key = ?",
                byte[].class, nativeKey)).containsExactly(nativeBytes);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource_ref"
                        + " WHERE resource_key = ? AND owner_kind = 'NATIVE_SNAPSHOT'",
                Long.class, nativeKey)).isEqualTo(1);
        assertNoPublicSnapshotCopies();
    }

    private List<String> columns(String table) {
        return jdbc.queryForList("SELECT column_name FROM information_schema.columns"
                + " WHERE table_schema = 'public' AND table_name = ?", String.class, table);
    }

    private void event(String item, String text) {
        transaction.executeWithoutResult(status -> store.appendPublicEventIfAbsent(TENANT, session,
                "turn", "item.output_text.delta", Map.of("itemId", item, "text", text),
                false, "event-" + UUID.randomUUID()));
    }

    private void materialize() {
        transaction.execute(status -> store.materializeNextBatch(TENANT, session, 100));
    }

    private String bodyKey() {
        return jdbc.queryForObject("SELECT body_resource_key FROM ma_message"
                + " WHERE tenant_id = ? AND session_id = ? AND item_id = ?",
                String.class, TENANT, session, "large");
    }

    private void assertNoPublicSnapshotCopies() {
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource WHERE kind IN (?, ?)",
                Long.class, "managed-snapshot-page", "managed-snapshot-manifest")).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource_ref"
                + " WHERE owner_kind = 'SNAPSHOT'", Long.class)).isZero();
    }
}
