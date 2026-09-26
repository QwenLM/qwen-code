package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
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
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.net.URLEncoder;
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
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;
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
        jdbc.update("INSERT INTO managed_agent_command (tenant_id, operation,"
                + " idempotency_key, request_digest, session_id, created_at)"
                + " VALUES ('mysql-upgrade', 'CREATE_SESSION', 'legacy-key',"
                + " 'legacy-digest', 'session_upgrade', 1)");
        Flyway.configure().dataSource(dataSource)
                .locations("classpath:db/migration").load().migrate();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " managed_agent_consumer_progress WHERE tenant_id = ?"
                        + " AND session_id = ? AND consumer_name = ?",
                Integer.class, "mysql-upgrade", "session_upgrade",
                "message_projection")).isEqualTo(1);
        ManagedAgentStore store = new ManagedAgentStore(
                jdbc, new ObjectMapper(), Clock.systemUTC(), ignored -> {
                }, new com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry(jdbc));
        assertThatThrownBy(() -> store.insertWorkspaceSessionCommand(
                "mysql-upgrade", "actor", "legacy-key", "bound-digest",
                "qwen-code", null, List.of(), null,
                new com.alibaba.qwen.code.managedagent.api.WorkspaceSelection("ws-a", ".")))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode()).isEqualTo("idempotency_conflict"));
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
        Timestamp persisted = jdbc.queryForObject(
                "SELECT writer_lease_until FROM qwen_managed_session_journal_head"
                        + " WHERE tenant_id = ? AND session_id = ?",
                Timestamp.class, tenant, session);
        assertThat(persisted).isNotNull();
        assertThat(persisted.getTime()).isEqualTo(grant.leaseUntil());
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
                        new JdbcTemplate(dataSource)));
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
                }, new ManagedWorkspaceRegistry(jdbc));
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
                }, registry);
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
                            "Create-Workspace", digest, "qwen-code", null,
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
