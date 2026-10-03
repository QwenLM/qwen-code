package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionProjection.TaskProjection;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionRecordStore;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.AcquireWriterRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.CommitReceipt;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.CommitResource;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.CommitTransactionRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.RenewWriterRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.SealWriterRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.WriterGrant;
import com.alibaba.qwen.code.managedagent.store.StoreModels.Admission;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ReplayWindow;
import com.alibaba.qwen.code.managedagent.store.StoreModels.TurnPage;
import com.alibaba.qwen.code.managedagent.store.StoreModels.TurnSummary;
import com.alibaba.qwen.code.runtimebroker.JdbcRepositoryContract;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Supplier;
import java.util.stream.IntStream;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationVersion;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class ManagedAgentMySqlIT {
    @Test
    @Order(1)
    void upgradesAndExercisesStoresOnMySql() throws IOException {
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
        jdbc.update("INSERT INTO managed_agent_command (tenant_id, operation,"
                + " idempotency_key, request_digest, session_id, created_at)"
                + " VALUES ('mysql-upgrade', 'CREATE_SESSION', 'legacy-key',"
                + " 'legacy-digest', 'session_upgrade', 1)");
        LegacyEvents.insert(jdbc, "mysql-upgrade", "session_upgrade");
        Flyway.configure().dataSource(dataSource)
                .locations("classpath:db/migration")
                .target(MigrationVersion.fromVersion("15")).load().migrate();
        LegacyLifecycleCommands.Sessions lifecycle =
                LegacyLifecycleCommands.insert(jdbc, "mysql-lifecycle");
        Flyway.configure().dataSource(dataSource)
                .locations("classpath:db/migration")
                .target(MigrationVersion.fromVersion("27")).load().migrate();
        LegacyHookRecords.insert(jdbc, "mysql-hooks", "session_hooks");
        Flyway.configure().dataSource(dataSource)
                .locations("classpath:db/migration").load().migrate();
        LegacyEvents.assertBackfilled(jdbc, "mysql-upgrade",
                "session_upgrade");
        LegacyLifecycleCommands.assertMigrated(jdbc, "mysql-lifecycle",
                lifecycle);
        LegacyHookRecords.assertBackfilled(jdbc, "mysql-hooks", "session_hooks");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " managed_agent_consumer_progress WHERE tenant_id = ?"
                        + " AND session_id = ? AND consumer_name = ?",
                Integer.class, "mysql-upgrade", "session_upgrade",
                "message_projection")).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT agent_revision FROM"
                        + " managed_agent_session WHERE session_id = ?",
                String.class, "session_upgrade")).isEqualTo("1");
        ManagedAgentStore store = new ManagedAgentStore(
                jdbc, new ObjectMapper(), Clock.systemUTC(), ignored -> {
                }, new com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry(jdbc),
                new ManagedAgentProperties());
        assertThatThrownBy(() -> store.insertWorkspaceSessionCommand(
                "mysql-upgrade", "actor", "legacy-key", "bound-digest",
                "qwen-code", null, null, List.of(), null,
                new com.alibaba.qwen.code.managedagent.api.WorkspaceSelection("ws-a", ".")))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode()).isEqualTo("idempotency_conflict"));
        String tenant = "mysql-projection";
        List<Map<String, Object>> input = List.of(Map.of(
                "type", "text", "text", "hello"));
        Admission admission = store.insertSessionCommand(tenant,
                "CREATE_SESSION", "mysql-create",
                "sha256:" + "a".repeat(64), "qwen-code", null, null, input,
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
        assertThat(store.advanceReplayFloor(tenant, admission.sessionId(),
                Long.MAX_VALUE)).isEqualTo(new ReplayWindow(6, 6));
        assertThat(store.findReplayWindow(tenant, admission.sessionId()))
                .isEqualTo(new ReplayWindow(6, 6));
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

    @ParameterizedTest
    @ValueSource(strings = {"LOCAL", "UTC", "+08:00", "Asia/Shanghai"})
    @Order(2)
    void shortWriterLeaseKeepsSubsecondDatabasePrecision(String connectionTimeZone)
            throws InterruptedException {
        DriverManagerDataSource dataSource = dataSource();
        String url = required("mysql.url");
        dataSource.setUrl(url + (url.contains("?") ? "&" : "?")
                + "connectionTimeZone=" + URLEncoder.encode(connectionTimeZone,
                        StandardCharsets.UTF_8));
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
        Long now = jdbc.queryForObject("SELECT UNIX_TIMESTAMP() * 1000"
                        + " + EXTRACT(MICROSECOND FROM CURRENT_TIMESTAMP(6)) DIV 1000",
                Long.class);

        assertThat(now).isNotNull();
        assertThat(grant.leaseUntil() - now)
                .isBetween(700L, 1_000L);
        Long persistedLeaseMicros = jdbc.queryForObject(
                "SELECT TIMESTAMPDIFF(MICROSECOND, CURRENT_TIMESTAMP(6),"
                        + " writer_lease_until) FROM"
                        + " qwen_managed_session_journal_head WHERE tenant_id"
                        + " = ? AND session_id = ?",
                Long.class, tenant, session);
        assertThat(persistedLeaseMicros).isPositive();
        assertLeaseDeadline(jdbc, tenant, session, grant);

        WriterGrant reacquired = inTransaction(transactions,
                () -> store.acquireWriter(tenant, session,
                        "cccccccccccccccccccccccccccccccc",
                        new AcquireWriterRequest("mysql-lease-workspace",
                                "mysql-lease-writer", 60_000L)));
        assertThat(reacquired.writerGeneration()).isEqualTo(1);
        assertThat(reacquired.replayed()).isTrue();
        assertLeaseDeadline(jdbc, tenant, session, reacquired);

        WriterGrant renewed = inTransaction(transactions,
                () -> store.renewWriter(tenant, session,
                        "cccccccccccccccccccccccccccccccc",
                        new RenewWriterRequest("mysql-lease-workspace",
                                "mysql-lease-writer", 1, 90_000L)));
        assertLeaseDeadline(jdbc, tenant, session, renewed);

        jdbc.update("UPDATE qwen_managed_session_journal_head SET"
                        + " writer_lease_until = TIMESTAMPADD(SECOND, -1,"
                        + " CURRENT_TIMESTAMP(6)) WHERE tenant_id = ?"
                        + " AND session_id = ?", tenant, session);
        WriterGrant takenOver = inTransaction(transactions,
                () -> store.acquireWriter(tenant, session,
                        "dddddddddddddddddddddddddddddddd",
                        new AcquireWriterRequest("mysql-lease-workspace",
                                "mysql-replacement-writer", 60_000L)));
        assertThat(takenOver.writerGeneration()).isEqualTo(2);
        assertLeaseDeadline(jdbc, tenant, session, takenOver);

        inTransaction(transactions,
                () -> store.sealWriter(tenant, session,
                        "dddddddddddddddddddddddddddddddd",
                        new SealWriterRequest("mysql-lease-workspace",
                                "mysql-replacement-writer", 2)));
        WriterGrant afterSeal = inTransaction(transactions,
                () -> store.acquireWriter(tenant, session,
                        "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
                        new AcquireWriterRequest("mysql-lease-workspace",
                                "mysql-post-seal-writer", 1_000L)));
        assertThat(afterSeal.writerGeneration()).isEqualTo(3);
        assertLeaseDeadline(jdbc, tenant, session, afterSeal);
    }

    private static void assertLeaseDeadline(JdbcTemplate jdbc, String tenant,
            String session, WriterGrant grant) {
        Long persisted = jdbc.queryForObject(
                "SELECT UNIX_TIMESTAMP(writer_lease_until) * 1000"
                        + " FROM qwen_managed_session_journal_head"
                        + " WHERE tenant_id = ? AND session_id = ?",
                Long.class, tenant, session);
        assertThat(persisted).isNotNull();
        assertThat(persisted).isEqualTo(grant.leaseUntil());
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
                }, new com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry(
                        new JdbcTemplate(dataSource)),
                new ManagedAgentProperties());
        Admission lower = store.insertSessionCommand("case-tenant",
                "CREATE_SESSION", "case-key", "case-digest", "qwen-code", null,
                null, List.of(), null);
        Admission upper = store.insertSessionCommand("CASE-TENANT",
                "CREATE_SESSION", "case-key", "case-digest", "qwen-code", null,
                null, List.of(), null);

        assertThat(upper.sessionId()).isNotEqualTo(lower.sessionId());
        assertThat(store.findSession("CASE-TENANT", lower.sessionId()))
                .isEmpty();
        assertThat(store.findSession("case-tenant", upper.sessionId()))
                .isEmpty();
        assertThat(store.listSessions("CASE-TENANT", null, null, null, 10)
                .sessions()).extracting(session -> session.sessionId())
                .containsExactly(upper.sessionId());
    }

    @Test
    @Order(5)
    void replaysOriginalWorkspaceBindingAcrossJvmAfterDefaultChanges()
            throws Exception {
        DriverManagerDataSource dataSource = dataSource();
        Flyway.configure().dataSource(dataSource)
                .locations("classpath:db/migration").load().migrate();
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);
        ManagedAgentStore store = new ManagedAgentStore(jdbc,
                new ObjectMapper(), Clock.systemUTC(), ignored -> {
                }, new ManagedWorkspaceRegistry(jdbc),
                new ManagedAgentProperties());
        String tenant = "mysql-workspace-" + UUID.randomUUID();
        try {
            for (String id : List.of("workspace-a", "workspace-b")) {
                jdbc.update("INSERT INTO managed_workspace_registry"
                                + " (tenant_id, workspace_id,"
                                + " workspace_generation, storage_id,"
                                + " display_name, config_ref, policy_ref,"
                                + " state) VALUES (?, ?, 3, ?, ?, ?, ?,"
                                + " 'ACTIVE')", tenant, id, "storage-a",
                        id, "config-a", "policy-a");
                jdbc.update("INSERT INTO managed_workspace_access"
                                + " (tenant_id, workspace_id, actor_id,"
                                + " can_read, can_create)"
                                + " VALUES (?, ?, ?, TRUE, TRUE)",
                        tenant, id, "actor-a".getBytes(StandardCharsets.UTF_8));
            }
            jdbc.update("INSERT INTO managed_workspace_default"
                    + " (tenant_id, workspace_id) VALUES (?, ?)",
                    tenant, "workspace-a");
            assertProcess(startWorkspaceProcess("create-and-exit", tenant,
                    null), 23, null);
            String sessionId = jdbc.queryForObject(
                    "SELECT session_id FROM managed_workspace_create_command"
                            + " WHERE tenant_id = ? AND actor_id = ?"
                            + " AND idempotency_key = ?",
                    String.class, tenant,
                    "actor-a".getBytes(StandardCharsets.UTF_8),
                    "workspace-create");
            var original = store.requireSession(tenant, sessionId).workspace();
            jdbc.update("UPDATE managed_workspace_default SET workspace_id = ?"
                    + " WHERE tenant_id = ?", "workspace-b", tenant);
            jdbc.update("UPDATE managed_workspace_registry SET"
                            + " workspace_generation = 4, state = 'DRAINING'"
                            + " WHERE tenant_id = ? AND workspace_id = ?",
                    tenant, "workspace-a");
            assertProcess(startWorkspaceProcess("replay", tenant, sessionId),
                    0, "W0_PROCESS_REPLAY_OK");
            assertThat(store.requireSession(tenant, sessionId).workspace())
                    .isEqualTo(original);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                            + " managed_agent_session WHERE tenant_id = ?",
                    Integer.class, tenant)).isEqualTo(1);
        } finally {
            jdbc.update("DELETE FROM managed_agent_event WHERE tenant_id = ?",
                    tenant);
            jdbc.update("DELETE FROM managed_workspace_create_command"
                    + " WHERE tenant_id = ?", tenant);
            jdbc.update("DELETE FROM managed_agent_consumer_progress"
                    + " WHERE tenant_id = ?", tenant);
            jdbc.update("DELETE FROM managed_agent_session WHERE tenant_id = ?",
                    tenant);
            jdbc.update("DELETE FROM managed_workspace_default"
                    + " WHERE tenant_id = ?", tenant);
            jdbc.update("DELETE FROM managed_workspace_access"
                    + " WHERE tenant_id = ?", tenant);
            jdbc.update("DELETE FROM managed_workspace_registry"
                    + " WHERE tenant_id = ?", tenant);
        }
    }

    @Test
    @Order(6)
    void workspaceActorAndCommandKeysStayCaseSensitiveOnMySql() {
        DriverManagerDataSource dataSource = dataSource();
        Flyway.configure().dataSource(dataSource)
                .locations("classpath:db/migration").load().migrate();
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);
        ManagedWorkspaceRegistry registry = new ManagedWorkspaceRegistry(jdbc);
        ManagedAgentStore store = new ManagedAgentStore(jdbc,
                new ObjectMapper(), Clock.systemUTC(), ignored -> {
                }, registry, new ManagedAgentProperties());
        TransactionTemplate transactions = new TransactionTemplate(
                new DataSourceTransactionManager(dataSource));
        String tenant = "mysql-actor-" + UUID.randomUUID();
        String workspace = "Workspace-A";
        String actor = "Actor-A";
        String digest = "sha256:" + "c".repeat(64);
        try {
            jdbc.update("INSERT INTO managed_workspace_registry"
                            + " (tenant_id, workspace_id,"
                            + " workspace_generation, storage_id,"
                            + " display_name, config_ref, policy_ref,"
                            + " state) VALUES (?, 'Workspace-0', 1,"
                            + " 'storage-hidden', 'Hidden', 'config-hidden',"
                            + " 'policy-hidden', 'ACTIVE')", tenant);
            jdbc.update("INSERT INTO managed_workspace_registry"
                            + " (tenant_id, workspace_id,"
                            + " workspace_generation, storage_id,"
                            + " display_name, config_ref, policy_ref,"
                            + " state) VALUES (?, ?, 1, 'storage-a',"
                            + " 'Workspace A', 'config-a', 'policy-a',"
                            + " 'ACTIVE')", tenant, workspace);
            jdbc.update("INSERT INTO managed_workspace_access"
                            + " (tenant_id, workspace_id, actor_id,"
                            + " can_read, can_create)"
                            + " VALUES (?, ?, ?, TRUE, TRUE)",
                    tenant, workspace, actor.getBytes(StandardCharsets.UTF_8));
            jdbc.update("INSERT INTO managed_workspace_access"
                            + " (tenant_id, workspace_id, actor_id,"
                            + " can_read, can_create)"
                            + " VALUES (?, 'Workspace-0', ?, TRUE, TRUE)",
                    tenant, "other".getBytes(StandardCharsets.UTF_8));
            Admission created = transactions.execute(status ->
                    store.insertWorkspaceSessionCommand(tenant, actor,
                            "Create-Workspace", digest, "qwen-code", null, null,
                            List.of(), null,
                            new com.alibaba.qwen.code.managedagent.api
                                    .WorkspaceSelection(workspace, ".")));
            assertThat(registry.canRead(tenant, actor, workspace)).isTrue();
            assertThat(registry.canRead(tenant, "actor-a", workspace))
                    .isFalse();
            assertThat(registry.canRead(tenant, actor, "workspace-a"))
                    .isFalse();
            assertThat(registry.listReadable(tenant, actor, null, 1))
                    .extracting(ManagedWorkspaceRegistry.WorkspaceSummary::workspaceId)
                    .containsExactly(workspace);
            assertThat(registry.listReadable(tenant, "actor-a", null, 1))
                    .isEmpty();
            assertThat(registry.listReadable(tenant.toUpperCase(), actor,
                    null, 1)).isEmpty();
            assertThat(registry.findReadable(tenant, actor, "workspace-a"))
                    .isNull();
            assertThat(registry.canRead(tenant.toUpperCase(), actor,
                    workspace)).isFalse();
            assertThat(store.listSessions(tenant, "actor-a", null, null,
                    10).sessions()).isEmpty();
            assertThatThrownBy(() -> transactions.execute(status ->
                    store.replayWorkspaceSessionCommand(tenant, "actor-a",
                            "Create-Workspace", digest)))
                    .isInstanceOfSatisfying(ApiException.class, error ->
                            assertThat(error.getCode())
                                    .isEqualTo("idempotency_conflict"));
            assertThatThrownBy(() -> transactions.execute(status ->
                    store.replayWorkspaceSessionCommand(tenant, actor,
                            "create-workspace", digest)))
                    .isInstanceOfSatisfying(ApiException.class, error ->
                            assertThat(error.getCode())
                                    .isEqualTo("idempotency_conflict"));
            assertThat(transactions.execute(status ->
                    store.replayWorkspaceSessionCommand(tenant, actor,
                            "Create-Workspace", digest)).sessionId())
                    .isEqualTo(created.sessionId());
        } finally {
            jdbc.update("DELETE FROM managed_agent_event WHERE tenant_id = ?",
                    tenant);
            jdbc.update("DELETE FROM managed_workspace_create_command"
                    + " WHERE tenant_id = ?", tenant);
            jdbc.update("DELETE FROM managed_agent_consumer_progress"
                    + " WHERE tenant_id = ?", tenant);
            jdbc.update("DELETE FROM managed_agent_session WHERE tenant_id = ?",
                    tenant);
            jdbc.update("DELETE FROM managed_workspace_access"
                    + " WHERE tenant_id = ?", tenant);
            jdbc.update("DELETE FROM managed_workspace_registry"
                    + " WHERE tenant_id = ?", tenant);
        }
    }

    @Test
    @Order(7)
    void runtimeBrokerRepositoriesKeepTheirContractOnFlywaySchema()
            throws Exception {
        DriverManagerDataSource dataSource = dataSource();
        Flyway.configure().dataSource(dataSource)
                .locations("classpath:db/migration").load().migrate();
        JdbcRepositoryContract.verify(dataSource,
                "flyway-" + UUID.randomUUID());
    }

    @Test
    @Order(8)
    void projectsStageHRecordsAndRollsBackARefusedOne() throws Exception {
        DriverManagerDataSource dataSource = dataSource();
        Flyway.configure().dataSource(dataSource)
                .locations("classpath:db/migration").load().migrate();
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);
        TransactionTemplate transactions = new TransactionTemplate(
                new DataSourceTransactionManager(dataSource));
        String tenant = "mysql-extension";
        String session = "mysql-extension-" + UUID.randomUUID();
        ExtensionRecordJournal journal = inTransaction(transactions,
                () -> new ExtensionRecordJournal(new ManagedSessionStore(jdbc),
                        tenant, "mysql-extension-workspace", session).open());
        JsonNode fixtures = ManagedExtensionProjectionContractTest.fixtures();
        JsonNode chain = fixtures.required("monitorChainCases").get(0)
                .required("revisions");
        for (int index = 0; index < chain.size() - 1; index++) {
            JsonNode revision = chain.get(index);
            String commandId = "monitor-" + index;
            inTransaction(transactions, () -> journal.commitMonitor(
                    commandId, revision.required("monitorRun"),
                    revision.required("occurredAt").longValue()));
        }
        ManagedExtensionRecordStore records =
                new ManagedExtensionRecordStore(jdbc, null);
        TaskProjection before = records.listTasks(tenant, session, null,
                null, 10).tasks().get(0).projection();

        assertThat(before).isEqualTo(ManagedExtensionProjectionContractTest
                .view(chain.get(chain.size() - 2).required("view")));

        // A body no revision committed, so its resource and its reference
        // are new rows that only a rollback removes.
        JsonNode refused = ((ObjectNode) chain.get(chain.size() - 2)
                .required("monitorRun").deepCopy()).put("maxEvents", 50);
        String refusedResource = ExtensionRecordJournal.resourceId(
                ExtensionRecordJournal.bytes(refused));
        int references = count(jdbc, "qwen_managed_session_resource_ref",
                tenant, session);
        assertThatThrownBy(() -> inTransaction(transactions,
                () -> journal.commitMonitor("refused", refused, 99_000)))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode()).isEqualTo(
                                ManagedExtensionRecordStore.ERROR_REJECTED));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " qwen_managed_session_resource WHERE tenant_id = ?"
                        + " AND session_id = ? AND resource_id = ?",
                Integer.class, tenant, session, refusedResource)).isZero();
        assertThat(count(jdbc, "qwen_managed_session_resource_ref", tenant,
                session)).isEqualTo(references);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " qwen_managed_session_journal_tx WHERE"
                        + " tenant_id = ? AND session_id = ? AND"
                        + " command_id = 'refused'", Integer.class, tenant,
                session)).isZero();
        assertThat(records.listTasks(tenant, session, null, null, 10).tasks()
                .get(0).projection()).isEqualTo(before);

        // A first revision checks its opening command through an index, not
        // by reading every record of its Session. The plan is asked of a
        // Session with enough records for the choice to matter.
        String scopeKey = sha256("explain-" + session);
        jdbc.batchUpdate("INSERT INTO qwen_managed_session_extension_record"
                        + " (session_scope_key, record_key, tenant_id,"
                        + " workspace_id, session_id, domain, record_id,"
                        + " operation_hash, revision, record_resource_id,"
                        + " task_kind, task_state, created_at) VALUES (?, ?,"
                        + " ?, ?, ?, 'monitor_run', ?, ?, 1, ?, 'monitor',"
                        + " 'pending', ?)",
                IntStream.range(0, 500)
                        .mapToObj(index -> new Object[] {scopeKey,
                                sha256("record-" + index), tenant,
                                "mysql-extension-workspace", "explain",
                                "monitor-" + index, sha256("command-" + index),
                                "resource-" + index, 1_000L + index})
                        .toList());
        jdbc.queryForList("ANALYZE TABLE"
                + " qwen_managed_session_extension_record");
        assertThat(jdbc.queryForList("EXPLAIN SELECT COUNT(*) FROM"
                        + " qwen_managed_session_extension_record WHERE"
                        + " session_scope_key = ? AND operation_hash = ?",
                scopeKey, sha256("command-7")))
                .extracting(row -> row.get("key"))
                .containsExactly("idx_managed_session_extension_operation");
    }

    @Test
    @Order(9)
    void announcesNothingAfterDeletionStartsMidCommit() throws Exception {
        DriverManagerDataSource dataSource = dataSource();
        Flyway.configure().dataSource(dataSource)
                .locations("classpath:db/migration").load().migrate();
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);
        TransactionTemplate transactions = new TransactionTemplate(
                new DataSourceTransactionManager(dataSource));
        ManagedAgentStore agents = new ManagedAgentStore(jdbc,
                new ObjectMapper(), Clock.systemUTC(), ignored -> {
                }, new ManagedWorkspaceRegistry(jdbc),
                new ManagedAgentProperties());
        String tenant = "mysql-extension-delete-" + UUID.randomUUID();
        String session = inTransaction(transactions,
                () -> agents.insertSessionCommand(tenant, "CREATE_SESSION",
                        "create", "sha256:" + "a".repeat(64), "qwen-code",
                        null, "tasks", List.of(), "sha256:" + "b".repeat(64)))
                .sessionId();
        // The public deletion starts after the private commit read its
        // snapshot; REPEATABLE READ hides it from a plain read. Completion
        // waits for the private writer, so it runs after this commit.
        AtomicReference<OperationRecord> deletion = new AtomicReference<>();
        AgentStateStore racing = (AgentStateStore) Proxy.newProxyInstance(
                AgentStateStore.class.getClassLoader(),
                new Class<?>[] {AgentStateStore.class},
                (proxy, method, arguments) -> {
                    if ("appendLiveSessionEventIfAbsent".equals(
                            method.getName())) {
                        CompletableFuture.runAsync(() -> {
                            String operation = inTransaction(transactions,
                                    () -> agents.beginOperation(tenant,
                                            session, OperationKind.DELETE,
                                            "sha256:" + "c".repeat(64),
                                            "delete", "digest-delete"))
                                    .operation().operationId();
                            deletion.set(inTransaction(transactions,
                                    () -> agents.claimOperation(tenant,
                                            session, operation, "worker",
                                            Duration.ofMinutes(1)))
                                    .orElseThrow());
                        }).join();
                    }
                    try {
                        return method.invoke(agents, arguments);
                    } catch (InvocationTargetException error) {
                        throw error.getCause();
                    }
                });
        ManagedSessionStore store = new ManagedSessionStore(jdbc,
                new ManagedExtensionRecordStore(jdbc, racing));
        ExtensionRecordJournal journal = inTransaction(transactions,
                () -> new ExtensionRecordJournal(store, tenant,
                        "mysql-extension-workspace", session).open());
        JsonNode start = ManagedExtensionProjectionContractTest.fixtures()
                .required("monitorChainCases").get(0).required("revisions")
                .get(0).required("monitorRun");
        inTransaction(transactions,
                () -> journal.commitMonitor("start", start, 1_000));

        assertThat(count(jdbc, "qwen_managed_session_extension_record",
                tenant, session)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT status FROM managed_agent_session"
                + " WHERE tenant_id = ? AND session_id = ?", String.class,
                tenant, session)).isEqualTo("DELETING");
        OperationRecord operation = deletion.get();
        assertThatThrownBy(() -> inTransaction(transactions,
                () -> agents.completeOperation(tenant, session,
                        operation.operationId(), "worker",
                        operation.claimGeneration(), true)))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode()).isEqualTo(
                                "managed_session_writer_active"));
        assertThat(count(jdbc, "qwen_output_session_retirement",
                tenant, session)).isZero();
        long generation = jdbc.queryForObject("SELECT writer_generation FROM"
                + " qwen_managed_session_journal_head WHERE tenant_id = ? AND"
                + " session_id = ?", Long.class, tenant, session);
        inTransaction(transactions, () -> store.sealWriter(tenant, session,
                "extension-writer-token-0123456789", new SealWriterRequest(
                        "mysql-extension-workspace", "writer-extension",
                        generation)));
        assertThat(inTransaction(transactions,
                () -> agents.completeOperation(tenant, session,
                        operation.operationId(), "worker",
                        operation.claimGeneration(), true))).isTrue();
        assertThat(jdbc.queryForObject("SELECT state FROM"
                + " qwen_managed_session_journal_head WHERE tenant_id = ? AND"
                + " session_id = ?", String.class, tenant, session))
                .isEqualTo("DELETED");
        assertThat(count(jdbc, "qwen_managed_session_extension_record",
                tenant, session)).isEqualTo(1);
        List<String> events = jdbc.queryForList("SELECT event_type FROM"
                        + " managed_agent_event WHERE tenant_id = ? AND"
                        + " session_id = ? ORDER BY sequence_id",
                String.class, tenant, session);
        assertThat(events).endsWith("session.deleted")
                .doesNotContain("task.updated");
    }

    @Test
    @Order(10)
    void admitsClaimsAndCompletesSessionOperationsOnMySql()
            throws InterruptedException {
        DriverManagerDataSource dataSource = dataSource();
        Flyway.configure().dataSource(dataSource)
                .locations("classpath:db/migration").load().migrate();
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);
        ManagedAgentStore store = new ManagedAgentStore(jdbc,
                new ObjectMapper(), Clock.systemUTC(), ignored -> {
                }, new ManagedWorkspaceRegistry(jdbc),
                new ManagedAgentProperties());
        TransactionTemplate transactions = new TransactionTemplate(
                new DataSourceTransactionManager(dataSource));
        String tenant = "mysql-operation-" + UUID.randomUUID();
        String sessionId = store.insertSessionCommand(tenant,
                "CREATE_SESSION", "create", "digest-create", "qwen-code", null,
                null, List.of(), null).sessionId();
        String actor = "sha256:" + "a".repeat(64);
        OperationRecord close = inTransaction(transactions,
                () -> store.beginOperation(tenant, sessionId,
                        OperationKind.CLOSE, actor, "Key", "digest-close"))
                .operation();
        assertThat(inTransaction(transactions, () -> store.beginOperation(
                tenant, sessionId, OperationKind.CLOSE, actor, "Key",
                "digest-close"))).satisfies(replay -> {
                    assertThat(replay.replayed()).isTrue();
                    assertThat(replay.operation().operationId())
                            .isEqualTo(close.operationId());
                });
        // Keys stay case-sensitive, and another actor's key is another
        // request; both meet the open close.
        for (String[] request : List.of(new String[] {actor, "key"},
                new String[] {"sha256:" + "b".repeat(64), "Key"})) {
            assertThatThrownBy(() -> inTransaction(transactions,
                    () -> store.beginOperation(tenant, sessionId,
                            OperationKind.CLOSE, request[0], request[1],
                            "digest-close")))
                    .isInstanceOfSatisfying(ApiException.class, error ->
                            assertThat(error.getCode())
                                    .isEqualTo("session_operation_active"));
        }
        assertThat(store.findDeliverableOperations(Long.MAX_VALUE, 1000))
                .extracting(target -> target.operationId())
                .contains(close.operationId());
        OperationRecord claimed = inTransaction(transactions,
                () -> store.claimOperation(tenant, sessionId,
                        close.operationId(), "worker-a",
                        Duration.ofMinutes(1))).orElseThrow();
        assertThat(inTransaction(transactions, () -> store.claimOperation(
                tenant, sessionId, close.operationId(), "worker-b",
                Duration.ofMinutes(1)))).isEmpty();
        assertThat(inTransaction(transactions, () -> store.completeOperation(
                tenant, sessionId, close.operationId(), "worker-b",
                claimed.claimGeneration(), true))).isFalse();
        assertThat(inTransaction(transactions, () -> store.completeOperation(
                tenant, sessionId, close.operationId(), "worker-a",
                claimed.claimGeneration(), true))).isTrue();
        assertThat(store.requireSession(tenant, sessionId).status())
                .isEqualTo("CLOSED");
        assertThat(store.findOperation(tenant, sessionId,
                close.operationId())).get().satisfies(completed -> {
                    assertThat(completed.state()).isEqualTo("COMPLETED");
                    assertThat(completed.admissionStage())
                            .isEqualTo("HARNESS_CONFIRMED");
                    assertThat(completed.receiptId()).startsWith("rcpt_");
                });
        assertThat(inTransaction(transactions, () -> store.beginOperation(
                tenant, sessionId, OperationKind.ARCHIVE, actor, "Key",
                "digest-archive")).operation().state())
                .isEqualTo("COMPLETED");
        assertThat(store.findEvents(tenant, sessionId, 0, 100))
                .extracting(event -> event.type())
                .containsExactly("session.created", "session.close.requested",
                        "session.closed", "session.archived");

        // A writer holds the journal until it is sealed or database time
        // passes its lease; the lifecycle worker waits for that.
        ManagedSessionStore journals = new ManagedSessionStore(jdbc);
        String token = "mysql-lifecycle-writer-token-00000000";
        long generation = inTransaction(transactions,
                () -> journals.acquireWriter(tenant, sessionId, token,
                        new AcquireWriterRequest("workspace", "writer",
                                60_000L))).writerGeneration();
        assertThat(journals.hasLiveWriter(tenant, sessionId)).isTrue();
        inTransaction(transactions, () -> journals.sealWriter(tenant,
                sessionId, token, new SealWriterRequest("workspace", "writer",
                        generation)));
        assertThat(journals.hasLiveWriter(tenant, sessionId)).isFalse();
        inTransaction(transactions, () -> journals.acquireWriter(tenant,
                sessionId, token, new AcquireWriterRequest("workspace",
                        "writer", 1_000L)));
        assertThat(journals.hasLiveWriter(tenant, sessionId)).isTrue();
        Thread.sleep(1_500);
        assertThat(journals.hasLiveWriter(tenant, sessionId)).isFalse();
    }

    @Test
    @Order(11)
    void pagesTurnsNewestFirstOnMySql() {
        DriverManagerDataSource dataSource = dataSource();
        Flyway.configure().dataSource(dataSource)
                .locations("classpath:db/migration").load().migrate();
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);
        ManagedAgentStore store = new ManagedAgentStore(jdbc,
                new ObjectMapper(), Clock.systemUTC(), ignored -> {
                }, new ManagedWorkspaceRegistry(jdbc),
                new ManagedAgentProperties());
        String tenant = "mysql-turns-" + UUID.randomUUID();
        String sessionId = store.insertSessionCommand(tenant,
                "CREATE_SESSION", "create", "digest-create", "qwen-code", null,
                null, List.of(), null).sessionId();
        // Turn IDs that differ only by case compare by their bytes, as the
        // binary collation stores them. The oldest Turn has the largest ID.
        for (String[] turn : List.of(new String[] {"turn_z", "500"},
                new String[] {"turn_a", "1000"},
                new String[] {"turn_B", "5000"},
                new String[] {"turn_b", "5000"},
                new String[] {"turn_c", "9000"})) {
            jdbc.update("INSERT INTO managed_agent_turn (tenant_id,"
                            + " session_id, turn_id, prompt_id, input_json,"
                            + " payload_digest, status, created_at,"
                            + " updated_at, completed_at) VALUES (?, ?, ?, ?,"
                            + " 'not json', 'digest', 'COMPLETED', ?, ?, ?)",
                    tenant, sessionId, turn[0], UUID.randomUUID().toString(),
                    Long.parseLong(turn[1]), Long.parseLong(turn[1]),
                    Long.parseLong(turn[1]) + 1);
        }

        List<String> order = new ArrayList<>();
        TurnPage page = store.listTurns(tenant, sessionId, null, null, 2);
        while (true) {
            page.turns().forEach(turn -> order.add(turn.turnId()));
            if (!page.hasMore()) {
                break;
            }
            TurnSummary last = page.turns().getLast();
            page = store.listTurns(tenant, sessionId, last.createdAt(),
                    last.turnId(), 2);
        }
        assertThat(order).containsExactly("turn_c", "turn_b", "turn_B",
                "turn_a", "turn_z");
        assertThat(store.findTurnSummary(tenant, sessionId, "turn_B"))
                .get().extracting(TurnSummary::createdAt,
                        TurnSummary::completedAt)
                .containsExactly(5000L, 5001L);
        assertThat(store.findTurnSummary(tenant, sessionId, "TURN_B"))
                .isEmpty();
        // The collation pads with spaces; the lookup still wants the exact ID.
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " managed_agent_turn WHERE tenant_id = ? AND"
                        + " session_id = ? AND turn_id = 'turn_B  '",
                Integer.class, tenant, sessionId)).isEqualTo(1);
        assertThat(store.findTurnSummary(tenant, sessionId, "turn_B  "))
                .isEmpty();
        assertThat(store.listTurns(tenant.toUpperCase(), sessionId, null,
                null, 10).turns()).isEmpty();
    }

    @Test
    @Order(12)
    void firstWriterAcquisitionsForDifferentTenantsDoNotDeadlock() throws Exception {
        var source = dataSource();
        var admin = new JdbcTemplate(source);
        String schema = "first_writer_" + UUID.randomUUID().toString().replace("-", "");
        admin.execute("CREATE DATABASE " + schema);
        var isolated = new DriverManagerDataSource(source.getUrl().replaceFirst("/[^/?]+(?=\\?|$)", "/" + schema),
                required("mysql.user"), System.getProperty("mysql.password", ""));
        try {
            Flyway.configure().dataSource(isolated).load().migrate();
            var ready = new java.util.concurrent.CountDownLatch(2);
            var release = new java.util.concurrent.CountDownLatch(1);
            var jdbc = new JdbcTemplate(isolated) {
                @Override public int update(String sql, Object... arguments) {
                    if (sql.startsWith("INSERT INTO qwen_managed_session_journal_head")) {
                        ready.countDown();
                        try { assertThat(release.await(10, TimeUnit.SECONDS)).isTrue(); }
                        catch (InterruptedException error) { throw new IllegalStateException(error); }
                    }
                    return super.update(sql, arguments);
                }
            };
            var store = new ManagedSessionStore(jdbc);
            var tx = new TransactionTemplate(new DataSourceTransactionManager(isolated));
            tx.setIsolationLevel(org.springframework.transaction.TransactionDefinition.ISOLATION_REPEATABLE_READ);
            tx.setTimeout(10);
            try (var workers = java.util.concurrent.Executors.newFixedThreadPool(2)) {
                var first = workers.submit(() -> tx.execute(status -> store.acquireWriter("first-tenant-a", "session-a",
                        "a".repeat(32), new AcquireWriterRequest("workspace", "writer-a", 60000L))));
                var second = workers.submit(() -> tx.execute(status -> store.acquireWriter("first-tenant-b", "session-b",
                        "b".repeat(32), new AcquireWriterRequest("workspace", "writer-b", 60000L))));
                try { assertThat(ready.await(10, TimeUnit.SECONDS)).isTrue(); }
                finally { release.countDown(); }
                assertThat(first.get(10, TimeUnit.SECONDS).writerGeneration()).isEqualTo(1);
                assertThat(second.get(10, TimeUnit.SECONDS).writerGeneration()).isEqualTo(1);
            } finally { release.countDown(); }
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_managed_session_journal_head", Long.class)).isEqualTo(2);
        } finally {
            admin.execute("DROP DATABASE " + schema);
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"UTC", "Asia/Tokyo"})
    @Order(12)
    void retentionClockAndWriterGuardIgnoreJvmTimezone(String timezone) throws Exception {
        var source = dataSource();
        Flyway.configure().dataSource(source).locations("classpath:db/migration").load().migrate();
        String java = Path.of(System.getProperty("java.home"), "bin",
                isWindows() ? "java.exe" : "java").toString();
        String classpath = System.getProperty("surefire.test.class.path",
                System.getProperty("java.class.path"));
        var builder = new ProcessBuilder(java, "-Duser.timezone=" + timezone, "-cp", classpath,
                com.alibaba.qwen.code.managedagent.store.ToolPublicationRetentionClockFixtureMain.class.getName())
                .redirectErrorStream(true);
        builder.environment().put("D1_MYSQL_URL", required("mysql.url"));
        builder.environment().put("D1_MYSQL_USER", required("mysql.user"));
        builder.environment().put("D1_MYSQL_PASSWORD", System.getProperty("mysql.password", ""));
        var process = builder.start();
        try {
            assertProcess(process, 0, "O4_RETENTION_CLOCK_OK");
        } finally {
            if (process.isAlive()) {
                process.destroyForcibly();
                process.waitFor(5, TimeUnit.SECONDS);
            }
        }
    }

    private static int count(JdbcTemplate jdbc, String table, String tenant,
            String session) {
        Integer rows = jdbc.queryForObject("SELECT COUNT(*) FROM " + table
                        + " WHERE tenant_id = ? AND session_id = ?",
                Integer.class, tenant, session);
        return rows == null ? 0 : rows;
    }

    @Test
    @Order(11)
    void originalWorkspaceHoldersRecoverWithoutCurrentAuthority() throws Exception {
        var source = dataSource();
        Flyway.configure().dataSource(source).locations("classpath:db/migration").load().migrate();
        var jdbc = new JdbcTemplate(source);
        var store = new ManagedAgentStore(jdbc, new ObjectMapper(), Clock.systemUTC(), ignored -> { },
                new ManagedWorkspaceRegistry(jdbc), new ManagedAgentProperties());
        var authority = new com.alibaba.qwen.code.managedagent.store.WorkspaceExecutionStore(jdbc,
                new DataSourceTransactionManager(source));
        com.alibaba.qwen.code.managedagent.service.WorkspaceRecoveryContract.verify(source, jdbc, store, authority);
        com.alibaba.qwen.code.managedagent.service.WorkspaceRecoveryContract.verifyOperatorPrepare(
                source, jdbc, store, authority);
    }

    @Test
    @Order(12)
    void admitsHookExecutionsWithoutReadingTheirHistoryOnMySql() throws Exception {
        DriverManagerDataSource dataSource = dataSource();
        Flyway.configure().dataSource(dataSource)
                .locations("classpath:db/migration").load().migrate();
        String session = "mysql-hooks-" + UUID.randomUUID();
        HookAdmissionHistory history = new HookAdmissionHistory(dataSource,
                "mysql-hook-index", "mysql-hook-workspace", session);
        // Equal modulo 4, so both admissions run the same checks.
        HookAdmissionHistory.Admission early = history.admitUntil(18);
        HookAdmissionHistory.Admission late = history.admitUntil(2002);
        System.out.printf("Hook admission at %d executions: %d SELECTs,"
                        + " %d statements, %.1f ms; at %d: %d SELECTs,"
                        + " %d statements, %.1f ms%n", early.history(),
                early.selects(), early.statements(), early.nanos() / 1e6,
                late.history(), late.selects(), late.statements(),
                late.nanos() / 1e6);
        assertThat(early.history()).isEqualTo(17);
        assertThat(late.history()).isEqualTo(2001);
        assertThat(early.selects()).as("lookups admitting execution %d",
                early.history()).isPositive();
        assertThat(early.statements()).isPositive();
        assertThat(late.selects()).isEqualTo(early.selects());
        assertThat(late.statements()).isEqualTo(early.statements());

        // Each admission lookup is an index lookup, not a scan of the
        // Session's Hook records. The lookups are the statements the store
        // ran above.
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);
        jdbc.queryForList("ANALYZE TABLE qwen_managed_session_extension_record");
        String scopeKey = sha256("mysql-hook-index\u0000" + session);
        for (Object[] lookup : List.of(
                new Object[] {"uq_managed_session_hook_once",
                        "hook_once_key_hash = ?", sha256("once-7")},
                new Object[] {"uq_managed_session_hook_ordinal",
                        "hook_occurrence_hash = ? AND hook_ordinal = ?",
                        sha256("occurrence-7"), 1},
                new Object[] {"uq_managed_session_hook_ordinal",
                        "hook_occurrence_hash = ?", sha256("occurrence-7")},
                new Object[] {"idx_managed_session_hook_definition",
                        "hook_definition_hash = ?", sha256("catalog-1\u00001")})) {
            Object[] arguments = new Object[lookup.length - 1];
            arguments[0] = scopeKey;
            System.arraycopy(lookup, 2, arguments, 1, lookup.length - 2);
            String query = "SELECT record_resource_id FROM"
                    + " qwen_managed_session_extension_record WHERE"
                    + " session_scope_key = ? AND " + lookup[1] + " LIMIT 1";
            assertThat(history.sql()).as((String) lookup[1]).contains(query);
            // MySQL may intersect the index with the primary key; either way
            // the lookup reads the index, never every row of the table.
            assertThat(jdbc.queryForList("EXPLAIN " + query, arguments))
                    .as((String) lookup[1]).singleElement().satisfies(plan -> {
                        assertThat(plan.get("type")).isNotIn("ALL", "index");
                        assertThat(String.valueOf(plan.get("key")).split(","))
                                .contains((String) lookup[0]);
                    });
        }
    }

    private static Process startWorkspaceProcess(String action,
            String tenant, String sessionId) throws IOException {
        String java = Path.of(System.getProperty("java.home"), "bin",
                isWindows() ? "java.exe" : "java").toString();
        String classpath = System.getProperty("surefire.test.class.path");
        if (classpath == null || classpath.isBlank()) {
            classpath = System.getProperty("java.class.path");
        }
        ProcessBuilder builder = new ProcessBuilder(java, "-cp", classpath,
                WorkspaceCreationProcessFixtureMain.class.getName())
                .redirectErrorStream(true);
        builder.environment().put("W0_MYSQL_URL", required("mysql.url"));
        builder.environment().put("W0_MYSQL_USER", required("mysql.user"));
        builder.environment().put("W0_MYSQL_PASSWORD",
                System.getProperty("mysql.password", ""));
        builder.environment().put("W0_TENANT", tenant);
        builder.environment().put("W0_ACTION", action);
        if (sessionId != null) {
            builder.environment().put("W0_SESSION", sessionId);
        }
        return builder.start();
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
