package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.AcquireWriterRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.CommitReceipt;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.CommitResource;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.CommitTransactionRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.SealWriterRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.WriterGrant;
import com.alibaba.qwen.code.managedagent.store.StoreModels.Admission;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.Timestamp;
import java.time.Clock;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationVersion;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class ManagedAgentMySqlIT {
    @Test
    @Order(1)
    void upgradesAndExercisesStoresOnMySql() {
        DriverManagerDataSource dataSource = dataSource();
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
                                ManagedSessionStoreModels
                                        .ERROR_RESOURCE_NOT_FOUND));

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

    @Test
    @Order(2)
    void shortWriterLeaseKeepsSubsecondDatabasePrecision()
            throws InterruptedException {
        DriverManagerDataSource dataSource = dataSource();
        Flyway.configure().dataSource(dataSource)
                .locations("classpath:db/migration").load().migrate();
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);
        String tenant = "mysql-lease-precision";
        String session = "mysql-lease-precision-session";
        jdbc.update("DELETE FROM qwen_managed_session_journal_head"
                + " WHERE tenant_id = ? AND session_id = ?", tenant,
                session);

        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
        boolean precisionWindowReached = false;
        while (System.nanoTime() < deadline) {
            Integer micros = jdbc.queryForObject(
                    "SELECT MICROSECOND(CURRENT_TIMESTAMP(6))",
                    Integer.class);
            if (micros != null && micros >= 600_000 && micros <= 700_000) {
                precisionWindowReached = true;
                break;
            }
            Thread.sleep(5);
        }
        assertThat(precisionWindowReached).isTrue();

        TransactionTemplate transactions = new TransactionTemplate(
                new DataSourceTransactionManager(dataSource));
        ManagedSessionStore store = new ManagedSessionStore(jdbc);
        WriterGrant grant = inTransaction(transactions,
                () -> store.acquireWriter(tenant, session,
                        "cccccccccccccccccccccccccccccccc",
                        new AcquireWriterRequest("mysql-lease-workspace",
                                "mysql-lease-writer", 1_000L)));
        Timestamp now = jdbc.queryForObject("SELECT CURRENT_TIMESTAMP(6)",
                Timestamp.class);

        assertThat(now).isNotNull();
        assertThat(grant.leaseUntil() - now.getTime())
                .isBetween(700L, 1_000L);
        Long persistedLeaseMicros = jdbc.queryForObject(
                "SELECT TIMESTAMPDIFF(MICROSECOND, CURRENT_TIMESTAMP(6),"
                        + " writer_lease_until) FROM"
                        + " qwen_managed_session_journal_head WHERE tenant_id"
                        + " = ? AND session_id = ?",
                Long.class, tenant, session);
        assertThat(persistedLeaseMicros).isPositive();
    }

    @Test
    @Order(3)
    void independentProcessesRecoverACommittedSessionAfterOwnerLoss()
            throws Exception {
        DriverManagerDataSource dataSource = dataSource();
        Flyway.configure().dataSource(dataSource)
                .locations("classpath:db/migration").load().migrate();
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);
        cleanupProcessFixture(jdbc);

        Process crashed = startStoreProcess("commit-and-crash");
        assertProcess(crashed, 23, null);
        awaitLeaseExpiry(jdbc);
        assertProcess(startStoreProcess("takeover"), 0,
                "D1_PROCESS_TAKEOVER_OK");
        assertProcess(startStoreProcess("replay"), 0,
                "D1_PROCESS_REPLAY_OK");
        assertProcess(startStoreProcess("stale-write"), 0,
                "D1_PROCESS_STALE_WRITER_OK");
        assertProcess(startStoreProcess("restore"), 0,
                "D1_PROCESS_RESTORE_OK");

        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " qwen_managed_session_journal_tx"
                        + " WHERE tenant_id = ? AND session_id = ?",
                Integer.class,
                ManagedSessionStoreProcessFixtureMain.TENANT,
                ManagedSessionStoreProcessFixtureMain.SESSION))
                .isEqualTo(1);
    }

    @Test
    @Order(4)
    void isolatesTenantsThatDifferOnlyByCase() {
        DriverManagerDataSource dataSource = dataSource();
        Flyway.configure().dataSource(dataSource)
                .locations("classpath:db/migration").load().migrate();
        ManagedAgentStore store = new ManagedAgentStore(
                new JdbcTemplate(dataSource), new ObjectMapper(),
                Clock.systemUTC(), ignored -> {
                });
        Admission lower = store.insertSessionCommand("case-tenant",
                "CREATE_SESSION", "case-key", "case-digest", "qwen-code",
                null, List.of(), null);
        Admission upper = store.insertSessionCommand("CASE-TENANT",
                "CREATE_SESSION", "case-key", "case-digest", "qwen-code",
                null, List.of(), null);

        assertThat(upper.sessionId()).isNotEqualTo(lower.sessionId());
        assertThat(store.findSession("CASE-TENANT", lower.sessionId()))
                .isEmpty();
        assertThat(store.findSession("case-tenant", upper.sessionId()))
                .isEmpty();
        assertThat(store.listSessions("CASE-TENANT", null, null, 10)
                .sessions()).extracting(session -> session.sessionId())
                .containsExactly(upper.sessionId());
    }

    private static void cleanupProcessFixture(JdbcTemplate jdbc) {
        Object[] scope = {
            ManagedSessionStoreProcessFixtureMain.TENANT,
            ManagedSessionStoreProcessFixtureMain.SESSION
        };
        jdbc.update("DELETE FROM qwen_managed_session_resource_ref"
                + " WHERE tenant_id = ? AND session_id = ?", scope);
        jdbc.update("DELETE FROM qwen_managed_session_resource"
                + " WHERE tenant_id = ? AND session_id = ?", scope);
        jdbc.update("DELETE FROM qwen_managed_session_journal_tx"
                + " WHERE tenant_id = ? AND session_id = ?", scope);
        jdbc.update("DELETE FROM qwen_managed_session_journal_head"
                + " WHERE tenant_id = ? AND session_id = ?", scope);
    }

    private static void awaitLeaseExpiry(JdbcTemplate jdbc)
            throws InterruptedException {
        long deadline = System.nanoTime()
                + TimeUnit.SECONDS.toNanos(10);
        while (System.nanoTime() < deadline) {
            Boolean expired = jdbc.queryForObject(
                    "SELECT writer_lease_until < CURRENT_TIMESTAMP(6)"
                            + " FROM qwen_managed_session_journal_head"
                            + " WHERE tenant_id = ? AND session_id = ?",
                    Boolean.class,
                    ManagedSessionStoreProcessFixtureMain.TENANT,
                    ManagedSessionStoreProcessFixtureMain.SESSION);
            if (Boolean.TRUE.equals(expired)) {
                return;
            }
            Thread.sleep(25);
        }
        throw new AssertionError("the crashed writer lease did not expire");
    }

    private static Process startStoreProcess(String action)
            throws IOException {
        String java = Path.of(System.getProperty("java.home"), "bin",
                isWindows() ? "java.exe" : "java").toString();
        String classpath = System.getProperty("surefire.test.class.path");
        if (classpath == null || classpath.isBlank()) {
            classpath = System.getProperty("java.class.path");
        }
        ProcessBuilder builder = new ProcessBuilder(java, "-cp", classpath,
                ManagedSessionStoreProcessFixtureMain.class.getName())
                .redirectErrorStream(true);
        builder.environment().put("D1_MYSQL_URL", required("mysql.url"));
        builder.environment().put("D1_MYSQL_USER", required("mysql.user"));
        builder.environment().put("D1_MYSQL_PASSWORD",
                System.getProperty("mysql.password", ""));
        builder.environment().put("D1_PROCESS_ACTION", action);
        return builder.start();
    }

    private static void assertProcess(Process process, int exitCode,
            String marker) throws Exception {
        boolean finished = process.waitFor(30, TimeUnit.SECONDS);
        if (!finished) {
            process.destroyForcibly();
            process.waitFor(5, TimeUnit.SECONDS);
        }
        String output = new String(process.getInputStream().readAllBytes(),
                StandardCharsets.UTF_8);
        assertThat(finished).as("Store process timed out:\n%s", output)
                .isTrue();
        assertThat(process.exitValue()).as("Store process failed:\n%s",
                output).isEqualTo(exitCode);
        if (marker != null) {
            assertThat(output).contains(marker);
        }
    }

    private static boolean isWindows() {
        return System.getProperty("os.name", "").toLowerCase()
                .contains("win");
    }

    private static DriverManagerDataSource dataSource() {
        return new DriverManagerDataSource(required("mysql.url"),
                required("mysql.user"),
                System.getProperty("mysql.password", ""));
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
