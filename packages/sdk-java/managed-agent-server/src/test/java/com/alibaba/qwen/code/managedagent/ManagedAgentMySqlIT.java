package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.AcquireWriterRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.CommitReceipt;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.CommitResource;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.CommitTransactionRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.SealWriterRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.WriterGrant;
import com.alibaba.qwen.code.managedagent.store.StoreModels.Admission;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationVersion;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

class ManagedAgentMySqlIT {
    @Test
    void upgradesAndExercisesStoresOnMySql() {
        DriverManagerDataSource dataSource = new DriverManagerDataSource(
                required("mysql.url"), required("mysql.user"),
                System.getProperty("mysql.password", ""));
        Flyway.configure().dataSource(dataSource)
                .locations("classpath:db/migration")
                .target(MigrationVersion.fromVersion("1")).load().migrate();
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);
        jdbc.update("INSERT INTO managed_agent_session (tenant_id,"
                        + " session_id, agent_id, status, created_at,"
                        + " updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                "mysql-upgrade", "session_upgrade", "qwen-code", "IDLE",
                1L, 1L);
        Flyway.configure().dataSource(dataSource)
                .locations("classpath:db/migration").load().migrate();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " managed_agent_consumer_progress WHERE tenant_id = ?"
                        + " AND session_id = ? AND consumer_name = ?",
                Integer.class, "mysql-upgrade", "session_upgrade",
                "message_projection")).isEqualTo(1);
        ManagedAgentStore store = new ManagedAgentStore(
                jdbc, new ObjectMapper(), Clock.systemUTC(), ignored -> {
                });
        String tenant = "mysql-projection";
        List<Map<String, Object>> input = List.of(Map.of(
                "type", "text", "text", "hello"));
        Admission admission = store.insertSessionCommand(tenant,
                "CREATE_SESSION", "mysql-create",
                "sha256:" + "a".repeat(64), "qwen-code", null, input,
                "sha256:" + "b".repeat(64));
        String assistantItem = "item_" + admission.turnId() + "_assistant";
        String part = "part_" + admission.turnId() + "_output_text";
        store.appendPublicEventIfAbsent(tenant, admission.sessionId(),
                admission.turnId(), "item.output_text.delta", Map.of(
                        "itemId", assistantItem, "contentPartId", part,
                        "text", "hel"), false, "mysql:1");
        store.appendPublicEventIfAbsent(tenant, admission.sessionId(),
                admission.turnId(), "item.output_text.delta", Map.of(
                        "itemId", assistantItem, "contentPartId", part,
                        "text", "lo"), false, "mysql:2");
        store.appendPublicEventIfAbsent(tenant, admission.sessionId(),
                admission.turnId(), "item.tool_call.updated", Map.of(
                        "toolCallId", "legacy-tool", "name", "read_file",
                        "status", "completed"), false, "mysql:legacy-tool");
        store.appendPublicEventIfAbsent(tenant, admission.sessionId(),
                admission.turnId(), "turn.completed", Map.of(), true,
                "mysql:3");

        assertThat(store.materializeNextBatch(tenant, admission.sessionId(),
                200).advanced()).isTrue();
        assertThat(store.findSnapshot(tenant, admission.sessionId()))
                .get().satisfies(snapshot -> {
                    assertThat(snapshot.coveredSequence()).isEqualTo(6);
                    assertThat(snapshot.items()).hasSize(3)
                            .filteredOn(item ->
                                    "assistant".equals(item.role()))
                            .filteredOn(item -> "message".equals(item.type()))
                            .singleElement().satisfies(item -> {
                                assertThat(item.status())
                                        .isEqualTo("completed");
                                assertThat(item.content()).singleElement()
                                        .extracting(content -> content.text())
                                        .isEqualTo("hello");
                            });
                    assertThat(snapshot.items())
                            .filteredOn(item -> "tool_call".equals(item.type()))
                            .singleElement().satisfies(item -> {
                                assertThat(item.status())
                                        .isEqualTo("completed");
                                assertThat(item.attributes())
                                        .containsEntry("toolCallId",
                                                "legacy-tool");
                            });
                });
        assertThat(store.materializeNextBatch(tenant, admission.sessionId(),
                200).advanced()).isFalse();

        TransactionTemplate transactions = new TransactionTemplate(
                new DataSourceTransactionManager(dataSource));
        ManagedSessionStore firstInstance = new ManagedSessionStore(jdbc);
        ManagedSessionStore secondInstance = new ManagedSessionStore(jdbc);
        String storeTenant = "mysql-private-store";
        String sessionId = "mysql-private-session";
        String workspaceId = "mysql-private-workspace";
        String tokenA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        String tokenB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        WriterGrant firstGrant = inTransaction(transactions,
                () -> firstInstance.acquireWriter(storeTenant, sessionId,
                        tokenA, new AcquireWriterRequest(workspaceId,
                                "writer-a", 60_000L)));
        assertThat(firstGrant.writerGeneration()).isEqualTo(1);
        assertThatThrownBy(() -> inTransaction(transactions,
                () -> secondInstance.acquireWriter(storeTenant, sessionId,
                        tokenB, new AcquireWriterRequest(workspaceId,
                                "writer-b", 60_000L))))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode()).isEqualTo(
                                "managed_session_writer_conflict"));

        String genesisRecords =
                "{\"subtype\":\"session_execution_engine\"}\n"
                        + "{\"subtype\":"
                        + "\"managed_session_header_v1\"}\n";
        byte[] resourceBytes = "mysql-resource"
                .getBytes(StandardCharsets.UTF_8);
        CommitTransactionRequest genesis = new CommitTransactionRequest(
                workspaceId, "writer-a", 1, 0, 0,
                "mysql-genesis-transaction", "session.create",
                "mysql-genesis-command", sha256(genesisRecords), 0, 0, 0,
                null, null, null, 0, null, 2,
                Base64.getEncoder().encodeToString(
                        genesisRecords.getBytes(StandardCharsets.UTF_8)),
                sha256(genesisRecords), List.of(new CommitResource(
                        "mysql-resource", "managed-context", 1,
                        resourceBytes.length, sha256("mysql-resource"),
                        Base64.getEncoder().encodeToString(resourceBytes))));
        CommitReceipt committed = inTransaction(transactions,
                () -> firstInstance.commit(storeTenant, sessionId, tokenA,
                        genesis));
        CommitReceipt replayed = inTransaction(transactions,
                () -> secondInstance.commit(storeTenant, sessionId, tokenA,
                        genesis));
        assertThat(replayed.journalRevision())
                .isEqualTo(committed.journalRevision());
        assertThat(replayed.transactionId())
                .isEqualTo(committed.transactionId());
        assertThat(replayed.replayed()).isTrue();
        assertThat(inTransaction(transactions,
                () -> secondInstance.readResource(storeTenant, workspaceId,
                        sessionId, "mysql-resource", tokenA)).bytes())
                .isEqualTo(resourceBytes);
        assertThatThrownBy(() -> inTransaction(transactions,
                () -> secondInstance.restore("MYSQL-PRIVATE-STORE",
                        workspaceId, sessionId, tokenA)))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode()).isEqualTo(
                                "managed_session_not_found"));
        assertThatThrownBy(() -> inTransaction(transactions,
                () -> secondInstance.readResource(storeTenant, workspaceId,
                        sessionId, "MYSQL-RESOURCE", tokenA)))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode()).isEqualTo(
                                "managed_session_not_found"));

        inTransaction(transactions, () -> firstInstance.sealWriter(
                storeTenant, sessionId, tokenA,
                new SealWriterRequest(workspaceId, "writer-a", 1)));
        WriterGrant secondGrant = inTransaction(transactions,
                () -> secondInstance.acquireWriter(storeTenant, sessionId,
                        tokenB, new AcquireWriterRequest(workspaceId,
                                "writer-b", 60_000L)));
        assertThat(secondGrant.writerGeneration()).isEqualTo(2);
        assertThat(inTransaction(transactions,
                () -> firstInstance.commit(storeTenant, sessionId, tokenA,
                        genesis)).replayed()).isTrue();

        String turnRecords =
                "{\"subtype\":\"managed_session_event_v1\"}\n"
                        + "{\"subtype\":"
                        + "\"managed_session_commit_v1\"}\n";
        CommitTransactionRequest staleCommit =
                new CommitTransactionRequest(workspaceId, "writer-a", 1,
                        1, 0, "mysql-turn-transaction", "turn.submit",
                        "mysql-turn-command", sha256("turn-content"),
                        1, 1, 1, "e".repeat(64), null,
                        "c".repeat(64), 0, null, 2,
                        Base64.getEncoder().encodeToString(turnRecords
                                .getBytes(StandardCharsets.UTF_8)),
                        sha256(turnRecords), List.of());
        assertThatThrownBy(() -> inTransaction(transactions,
                () -> firstInstance.commit(storeTenant, sessionId, tokenA,
                        staleCommit)))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode()).isEqualTo(
                                "managed_session_writer_conflict"));
    }

    private static <T> T inTransaction(TransactionTemplate transactions,
            Supplier<T> operation) {
        return transactions.execute(status -> operation.get());
    }

    private static String sha256(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest
                    .getInstance("SHA-256").digest(
                            value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }

    private static String required(String name) {
        String value = System.getProperty(name);
        if (value == null || value.isBlank()) {
            throw new IllegalStateException(name + " is required");
        }
        return value;
    }
}
