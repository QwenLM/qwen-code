package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.ExtensionRecordJournal;
import com.alibaba.qwen.code.managedagent.ManagedHookRecordContractTest;
import com.alibaba.qwen.code.managedagent.PublicationJournalFixture;
import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.AcquireWriterRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.AuthorizeLifecycleRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.BlockRecoveryRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.CommitResource;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.CommitTransactionRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.RenewWriterRequest;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.DefaultTransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Witness for #13800: an externally held tenant guard row must not wedge
 * ordinary traffic of unrelated Sessions; admissions that legitimately
 * fence fail fast with a named error instead of out-waiting the caller.
 */
class ManagedSessionGuardConvoyIT {
    private static final ObjectMapper JSON = new ObjectMapper();

    private DriverManagerDataSource source;
    private JdbcTemplate admin;
    private String schema;

    @BeforeEach
    void openSchema() {
        String url = System.getProperty("mysql.url");
        if (url == null || !url.matches("jdbc:mysql://[^/]+/[^?]+(?:\\?.*)?")) {
            throw new IllegalArgumentException("A MySQL test database URL is required");
        }
        String user = System.getProperty("mysql.user", "root");
        String password = System.getProperty("mysql.password", "");
        admin = new JdbcTemplate(new DriverManagerDataSource(url, user, password));
        schema = "gc_" + UUID.randomUUID().toString().replace("-", "");
        admin.execute("CREATE DATABASE " + schema);
        source = new DriverManagerDataSource(url.replaceFirst("/[^/?]+(?=\\?|$)", "/" + schema), user, password);
        Flyway.configure().dataSource(source).locations("classpath:db/migration").load().migrate();
    }

    @AfterEach
    void removeSchema() {
        if (admin != null && schema != null) {
            admin.execute("DROP DATABASE IF EXISTS " + schema);
        }
    }

    @Test
    void heldTenantGuardsDoNotWedgeUnrelatedSessions() throws Exception {
        var jdbc = new JdbcTemplate(source);
        var manager = new DataSourceTransactionManager(source);
        var transactions = new TransactionTemplate(manager);
        var store = new ManagedSessionStore(jdbc);
        String tenant = "tenant-a";
        String workspace = "workspace-a";
        String token = "w".repeat(32);
        var grant = transactions.execute(ignored -> store.acquireWriter(tenant, "victim", token,
                new AcquireWriterRequest(workspace, "writer-victim", 60_000L)));
        transactions.executeWithoutResult(ignored -> store.acquireWriter(tenant, "blocked", token,
                new AcquireWriterRequest(workspace, "writer-blocked", 60_000L)));
        var journalWriter = transactions.execute(ignored ->
                new ExtensionRecordJournal(store, tenant, workspace, "committer").open());
        jdbc.update("UPDATE qwen_managed_session_journal_head SET recovery_status = 'BLOCKED_RESOURCE',"
                + " recovery_detail_code = 'a2-witness' WHERE tenant_id = ? AND session_id = ?",
                tenant, "blocked");

        var holdTx = manager.getTransaction(new DefaultTransactionDefinition());
        // Hold both tenant-wide guards the way a fat lifecycle transaction
        // would, on a connection the test never commits.
        ToolPublicationRetentionStore.lockTenant(jdbc, tenant);
        WorkspaceLifecycleStore.lockPlacement(jdbc, tenant);
        try {
            var templates = ManagedHookRecordContractTest.fixtures().get("templates");
            var data = new CommitResource("hook-data", "hook-data", 1, 2, sha256("{}"), "e30=");
            ObjectNode registration = templates.get("hook_registration").deepCopy();
            registration.withObject("/catalogRef").put("digest", data.digest());
            var request = journalWriter.requestDomain("witness-hold", "hook_registration",
                    registration, List.of(data), System.currentTimeMillis());
            try (var pool = Executors.newFixedThreadPool(4)) {
                var renewed = pool.submit(() -> transactions.execute(ignored -> store.renewWriter(tenant, "victim", token,
                        new RenewWriterRequest(workspace, "writer-victim", grant.writerGeneration(), 60_000L))));
                var authorized = pool.submit(() -> {
                    transactions.executeWithoutResult(ignored -> store.authorizeOrdinary(tenant, "victim", token,
                            new AuthorizeLifecycleRequest(workspace, "writer-victim", grant.writerGeneration())));
                    return null;
                });
                var committed = pool.submit(() -> transactions.execute(ignored -> journalWriter.commit(request)));
                var blockedAgain = pool.submit(() -> transactions.execute(ignored -> store.blockRecovery(tenant, "blocked", token,
                        new BlockRecoveryRequest(workspace, "writer-blocked", 1, "BLOCKED_RESOURCE", "a2-witness"))));
                renewed.get(30, TimeUnit.SECONDS);
                authorized.get(30, TimeUnit.SECONDS);
                committed.get(30, TimeUnit.SECONDS);
                blockedAgain.get(30, TimeUnit.SECONDS);
            }

            // The admission that legitimately fences fails fast and named.
            // It must run on a fresh thread: on the holder's own Thread the
            // call would join the held transaction and see no contention.
            long before = System.nanoTime();
            try (var admissionPool = Executors.newSingleThreadExecutor()) {
                assertThatThrownBy(() -> admissionPool.submit(() -> transactions.executeWithoutResult(ignored ->
                        store.acquireWriter(tenant, "late", token,
                                new AcquireWriterRequest(workspace, "writer-late", 60_000L))))
                        .get(30, TimeUnit.SECONDS))
                        .isInstanceOf(java.util.concurrent.ExecutionException.class)
                        .satisfies(error -> {
                            var cause = error.getCause();
                            assertThat(cause).isInstanceOf(ApiException.class);
                            assertThat(((ApiException) cause).getStatus())
                                    .isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
                            assertThat(((ApiException) cause).getCode())
                                    .isEqualTo("tenant_guard_contended");
                        });
            }
            long elapsedMs = (System.nanoTime() - before) / 1_000_000;
            assertThat(elapsedMs).isLessThan(25_000);

            // The lifecycle-authorisation lane fences through the same
            // bounded guards: a held row answers named and fast rather than
            // waiting out the caller's own budget behind it.
            long lifecycleBefore = System.nanoTime();
            try (var lifecyclePool = Executors.newSingleThreadExecutor()) {
                assertThatThrownBy(() -> lifecyclePool.submit(() -> transactions.executeWithoutResult(ignored ->
                        store.authorizeLifecycle(tenant, "victim", token,
                                new AuthorizeLifecycleRequest(workspace, "writer-victim", grant.writerGeneration()),
                                new RuntimeLifecycleAuthority("witness-operation", 1))))
                        .get(30, TimeUnit.SECONDS))
                        .isInstanceOf(java.util.concurrent.ExecutionException.class)
                        .satisfies(error -> {
                            var cause = error.getCause();
                            assertThat(cause).isInstanceOf(ApiException.class);
                            assertThat(((ApiException) cause).getStatus())
                                    .isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
                            assertThat(((ApiException) cause).getCode())
                                    .isEqualTo("tenant_guard_contended");
                        });
            }
            long lifecycleElapsedMs = (System.nanoTime() - lifecycleBefore) / 1_000_000;
            assertThat(lifecycleElapsedMs).isLessThan(25_000);
        } finally {
            manager.rollback(holdTx);
        }

        // The hold is gone; the same admission now succeeds.
        transactions.executeWithoutResult(ignored -> store.acquireWriter(tenant, "late", token,
                new AcquireWriterRequest(workspace, "writer-late", 60_000L)));
        // And the blocked neighbour reports its own blocked state unchanged.
        assertThat(jdbc.queryForObject("SELECT CONCAT(recovery_status, ':', recovery_detail_code) FROM"
                + " qwen_managed_session_journal_head WHERE tenant_id = ? AND session_id = ?",
                String.class, tenant, "blocked")).isEqualTo("BLOCKED_RESOURCE:a2-witness");
    }

    private static String sha256(String value) throws NoSuchAlgorithmException {
        return HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));
    }

    /**
     * A duplicate commit parked at the head lock must replay the winner
     * once the winner commits: the retry's snapshot is only allowed to be
     * pinned after the head row is locked, or it misses the winner's
     * transaction and the duplicate surfaces a 409 (#13800 R1).
     */
    @Test
    void duplicateCommitReplaysAfterWaitingForTheHeadLock() throws Exception {
        var jdbc = new JdbcTemplate(source);
        var manager = new DataSourceTransactionManager(source);
        var transactions = new TransactionTemplate(manager);
        var store = new ManagedSessionStore(jdbc);
        String tenant = "tenant-a";
        String workspace = "workspace-a";
        String token = "w".repeat(32);
        var journalWriter = transactions.execute(ignored ->
                new ExtensionRecordJournal(store, tenant, workspace, "victim").open());

        var templates = ManagedHookRecordContractTest.fixtures().get("templates");
        var data = new CommitResource("hook-data", "hook-data", 1, 2, sha256("{}"), "e30=");
        ObjectNode registration = templates.get("hook_registration").deepCopy();
        registration.withObject("/catalogRef").put("digest", data.digest());
        var request = journalWriter.requestDomain("replay-window", "hook_registration",
                registration, List.of(data), System.currentTimeMillis());

        // The winner runs inside a held transaction: every statement has
        // executed and the head row is locked, but nothing is visible yet.
        var winner = manager.getTransaction(new DefaultTransactionDefinition());
        var first = journalWriter.commit(request);
        try (var pool = Executors.newSingleThreadExecutor()) {
            var retry = pool.submit(() ->
                    transactions.execute(ignored -> journalWriter.commit(request)));
            awaitWaitingLock(jdbc, "qwen_managed_session_journal_head");
            manager.commit(winner);
            var second = retry.get(30, TimeUnit.SECONDS);
            assertThat(second.replayed()).isTrue();
            assertThat(second.journalRevision()).isEqualTo(first.journalRevision());
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_managed_session_journal_tx"
                        + " WHERE tenant_id = ? AND session_id = ? AND operation = 'commitMcpRecord'",
                Integer.class, tenant, "victim")).isOne();
    }

    /**
     * Publication lanes take their first tenant-wide acquisition with the
     * hot-path bound: reserve (apply lane), prepareAdmission (admission
     * lane) and commitReceipt (receipt lane's placement-first entry) all
     * answer tenant_guard_contended within the bound while a guard row is
     * externally held, and complete after the hold lifts (#13800 R1).
     */
    @Test
    void heldTenantGuardsBoundPublicationLaneEntries() throws Exception {
        var journal = PublicationJournalFixture.create(source, false);
        var jdbc = journal.jdbc;
        var manager = journal.manager;
        String tenant = "tenant-1";
        var key = journal.binding.get("sessionKey");

        var hold = manager.getTransaction(new DefaultTransactionDefinition());
        ToolPublicationRetentionStore.lockTenant(jdbc, tenant);
        try {
            assertFastGuardFailure(() -> {
                journal.reserve();
                return null;
            });
        } finally {
            manager.rollback(hold);
        }
        journal.reserve();

        ToolPublicationObjectStore objects = new ToolPublicationObjectStore() {
            @Override
            public void putIfAbsent(String objectKey, byte[] bytes) {
                throw new AssertionError("Inline fixture expected");
            }

            @Override
            public InputStream open(String objectKey) {
                throw new AssertionError("Inline fixture expected");
            }

            @Override
            public void requireUnversioned() {
            }
        };
        var data = new ToolPublicationDataStore(jdbc, journal.manager, journal.store,
                journal.sessions, objects, Duration.ofMinutes(2), Duration.ofSeconds(30),
                new ToolPublicationDataStore.VerificationBudget(16 * 1024 * 1024,
                        Duration.ofMinutes(25)));
        var envelope = JSON.createObjectNode().put("executionStatus", "error");
        envelope.putArray("responseParts");
        envelope.set("capture", JSON.createObjectNode().put("captureStatus", "unavailable")
                .put("captureReason", "storage_failed").put("previewTruncated", false)
                .put("deliveryStatus", "pending").putNull("manifest"));
        data.finish(key, "pub-1", PublicationJournalFixture.PUBLICATION_TOKEN, "finish",
                envelope.toString().getBytes(StandardCharsets.UTF_8));
        var outcome = JSON.createObjectNode().put("schemaVersion", 1).put("decision", "blocked")
                .putNull("manifestRef");
        outcome.set("envelope", envelope);
        var history = JSON.createObjectNode()
                .put("messageId", "11111111-1111-4111-8111-111111111111")
                .put("timestamp", "2026-10-06T00:00:00Z").put("model", "test");
        history.putArray("parts").addObject().put("text", "Shell capture unavailable");
        outcome.set("history", history);

        hold = manager.getTransaction(new DefaultTransactionDefinition());
        ToolPublicationRetentionStore.lockTenant(jdbc, tenant);
        try {
            assertFastGuardFailure(() ->
                    data.prepareAdmission(key, "pub-1", "writer-1", 1,
                            PublicationJournalFixture.WRITER_TOKEN, outcome));
        } finally {
            manager.rollback(hold);
        }
        var root = data.prepareAdmission(key, "pub-1", "writer-1", 1,
                PublicationJournalFixture.WRITER_TOKEN, outcome);

        long sequence = journal.sequence + 1;
        var payload = JSON.createObjectNode().put("executionCallId", "execution-1")
                .put("historyRevision", sequence).putNull("resultRef");
        payload.set("toolOutcomeRef", root);
        payload.putArray("resources");
        String records = journal.event(sequence, "tool.receipt", payload)
                + PublicationJournalFixture.COMMIT_MARKER;
        var request = new CommitTransactionRequest("workspace-1", "writer-1", 1, journal.revision,
                journal.sequence, "receipt", "recordToolResult", "execution-1",
                root.path("digest").asText(), sequence, sequence, 1,
                PublicationJournalFixture.digest(records), journal.commitDigest,
                PublicationJournalFixture.digest(records), 1, null, 2,
                Base64.getEncoder().encodeToString(records.getBytes(StandardCharsets.UTF_8)),
                PublicationJournalFixture.digest(records),
                List.of(new CommitResource(root.path("resourceId").asText(),
                        "managed-tool-outcome", 1, root.path("byteLength").asLong(),
                        root.path("digest").asText(), null)));
        var admission = new ToolPublicationAdmissionStore(jdbc, journal.manager,
                journal.sessions, data);

        hold = manager.getTransaction(new DefaultTransactionDefinition());
        WorkspaceLifecycleStore.lockPlacement(jdbc, tenant);
        try {
            assertFastGuardFailure(() ->
                    admission.commitReceipt(key, "pub-1", PublicationJournalFixture.WRITER_TOKEN,
                            request));
        } finally {
            manager.rollback(hold);
        }
        assertThat(admission.commitReceipt(key, "pub-1", PublicationJournalFixture.WRITER_TOKEN,
                request).path("historyRevision").asLong()).isEqualTo(sequence);
    }

    /**
     * The writer-acquisition lane takes the placement guard before reading
     * the drain fence: begin paths insert drain rows only after locking
     * placement, so checking the drain first used to hold its gap lock and
     * deadlock with a lifecycle holding placement. Now the lifecycle side
     * always completes, the writer fails with the named fence conflict, and
     * an unrelated Session of the same tenant still acquires (#13800 R1).
     */
    @Test
    void writerAcquisitionOrdersPlacementBeforeTheDrainFence() throws Exception {
        var jdbc = new JdbcTemplate(source);
        var manager = new DataSourceTransactionManager(source);
        var transactions = new TransactionTemplate(manager);
        var store = new ManagedSessionStore(jdbc);
        String tenant = "tenant-a";
        String workspace = "workspace-a";
        String token = "w".repeat(32);
        transactions.executeWithoutResult(ignored -> store.acquireWriter(tenant, "victim",
                token, new AcquireWriterRequest(workspace, "writer-victim", 60_000L)));

        // Hold lifecycle's placement guard: the begin path always locks it
        // before inserting a drain row.
        var lifecycle = manager.getTransaction(new DefaultTransactionDefinition());
        WorkspaceLifecycleStore.lockPlacement(jdbc, tenant);
        long deadlocksBefore = innodbDeadlocks(jdbc);
        try (var pool = Executors.newSingleThreadExecutor()) {
            var writer = pool.submit(() -> transactions.executeWithoutResult(ignored ->
                    store.acquireWriter(tenant, "victim", token,
                            new AcquireWriterRequest(workspace, "writer-victim", 60_000L))));
            awaitWaitingLock(jdbc, "qwen_runtime_placement_guard");
            // The begin path's drain insert must complete inside the same
            // transaction window: a drain-first writer order would have the
            // writer holding this gap and deadlock the pair.
            jdbc.update("INSERT INTO qwen_runtime_harness_drain (tenant_key, harness_key,"
                            + " tenant_id, harness_session_id) VALUES (?, ?, ?, ?)"
                            + " ON DUPLICATE KEY UPDATE phase = 'DRAINING', claim_lease_until = NULL",
                    JdbcRuntimeBindingRepository.harnessDrainKey(tenant),
                    JdbcRuntimeBindingRepository.harnessDrainKey("victim"), tenant, "victim");
            manager.rollback(lifecycle);
            assertThat(innodbDeadlocks(jdbc) - deadlocksBefore)
                    .as("no InnoDB deadlock must form between lifecycle placement and writer admission")
                    .isZero();
        }
        // A real lifecycle would commit the drain instead of rolling it
        // back; replay that final state explicitly.
        transactions.executeWithoutResult(ignored ->
                jdbc.update("INSERT INTO qwen_runtime_harness_drain (tenant_key, harness_key,"
                                + " tenant_id, harness_session_id) VALUES (?, ?, ?, ?)"
                                + " ON DUPLICATE KEY UPDATE phase = 'DRAINING', claim_lease_until = NULL",
                        JdbcRuntimeBindingRepository.harnessDrainKey(tenant),
                        JdbcRuntimeBindingRepository.harnessDrainKey("victim"), tenant, "victim"));
        assertThatThrownBy(() -> transactions.executeWithoutResult(ignored ->
                store.acquireWriter(tenant, "victim", token,
                        new AcquireWriterRequest(workspace, "writer-victim", 60_000L))))
                .isInstanceOf(ApiException.class)
                .satisfies(error -> {
                    assertThat(((ApiException) error).getStatus()).isEqualTo(HttpStatus.CONFLICT);
                    assertThat(((ApiException) error).getCode())
                            .isEqualTo("managed_session_lifecycle_active");
                });
        transactions.executeWithoutResult(ignored -> store.acquireWriter(tenant, "neighbor",
                token, new AcquireWriterRequest(workspace, "writer-neighbor", 60_000L)));
    }

    private static void awaitWaitingLock(JdbcTemplate jdbc, String table)
            throws InterruptedException {
        for (int attempt = 0; attempt < 100; attempt++) {
            Integer waits = jdbc.queryForObject(
                    "SELECT COUNT(*) FROM sys.innodb_lock_waits WHERE locked_table LIKE ?",
                    Integer.class, "%" + table + "%");
            if (waits != null && waits > 0) {
                return;
            }
            Thread.sleep(100);
        }
        throw new AssertionError("Timed out waiting for a lock wait on " + table);
    }

    private static long innodbDeadlocks(JdbcTemplate jdbc) {
        Long value = jdbc.query("SHOW GLOBAL STATUS LIKE 'Innodb_deadlocks'",
                result -> result.next() ? result.getLong(2) : null);
        return value == null ? -1 : value;
    }

    private static void assertFastGuardFailure(Callable<Object> action) throws Exception {
        long before = System.nanoTime();
        try (var pool = Executors.newSingleThreadExecutor()) {
            assertThatThrownBy(() -> pool.submit(action).get(30, TimeUnit.SECONDS))
                    .isInstanceOf(ExecutionException.class)
                    .satisfies(error -> {
                        var cause = error.getCause();
                        assertThat(cause).isInstanceOf(ApiException.class);
                        assertThat(((ApiException) cause).getStatus())
                                .isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
                        assertThat(((ApiException) cause).getCode())
                                .isEqualTo("tenant_guard_contended");
                    });
        }
        long elapsedMs = (System.nanoTime() - before) / 1_000_000;
        assertThat(elapsedMs).isLessThan(25_000);
    }
}
