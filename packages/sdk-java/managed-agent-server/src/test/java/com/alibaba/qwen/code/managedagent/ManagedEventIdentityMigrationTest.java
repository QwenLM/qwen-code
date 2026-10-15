package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Clock;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

class ManagedEventIdentityMigrationTest {
    @Test
    void freshEventsAndBatchedMessageProjectionKeepTheSameStablePartIdentity() {
        var source = new JdbcDataSource();
        source.setURL(
                "jdbc:h2:mem:event-identity32-"
                        + UUID.randomUUID()
                        + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1");
        ManagedSchema.initialize(source);
        var jdbc = new ManagedSchemaJdbcTemplate(source);
        var transactions = new TransactionTemplate(new DataSourceTransactionManager(source));
        var store =
                new ManagedAgentStore(
                        jdbc,
                        new ObjectMapper(),
                        Clock.systemUTC(),
                        ignored -> {},
                        new ManagedWorkspaceRegistry(jdbc),
                        new ManagedAgentProperties());
        String tenant = "tenant";
        String session =
                transactions
                        .execute(
                                status ->
                                        store.insertSessionCommand(
                                                tenant,
                                                "CREATE_SESSION",
                                                "key",
                                                "digest",
                                                "qwen-code",
                                                null,
                                                null,
                                                List.of(),
                                                null))
                        .sessionId();
        transactions.executeWithoutResult(
                status -> {
                    for (int i = 0; i < 1200; i++) {
                        store.appendPublicEventIfAbsent(
                                tenant,
                                session,
                                "turn",
                                "item.output_text.delta",
                                Map.of("text", "x"),
                                false,
                                "source-" + i);
                    }
                });
        boolean advanced;
        do {
            advanced = transactions.execute(status -> store.materializeNextBatch(tenant, session, 200)).advanced();
        }
        while (advanced);
        jdbc.update("UPDATE ma_snapshot SET published_at = published_at - 6000 WHERE tenant_id = ? AND session_id = ?", tenant, session);
        transactions.executeWithoutResult(status -> store.materializeNextBatch(tenant, session, 200));
        var identities =
                jdbc.queryForList(
                        "SELECT DISTINCT item_id, content_part_id FROM ma_public_event WHERE"
                            + " tenant_id = ? AND session_id = ? AND event_type ="
                            + " 'item.output_text.delta'",
                        tenant,
                        session);
        assertThat(identities).hasSize(1);
        var identity = identities.getFirst();
        var item = store.findSnapshot(tenant, session).orElseThrow().items().getFirst();
        assertThat(item.itemId()).isEqualTo(identity.get("item_id"));
        assertThat(item.content()).hasSize(1);
        assertThat(item.content().getFirst().partId()).isEqualTo(identity.get("content_part_id"));
        assertThat(item.content().getFirst().text().length()).isEqualTo(1200);
        assertThat(store.requireSession(tenant, session).lastSequence()).isEqualTo(1201);
        assertThat(store.findReplayWindow(tenant, session).floorSequence()).isZero();
    }
}
