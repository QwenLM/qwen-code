package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.druid.pool.DruidDataSource;
import com.alibaba.qwen.code.managedagent.ExtensionRecordJournal;
import com.alibaba.qwen.code.managedagent.ManagedHookRecordContractTest;
import com.alibaba.qwen.code.managedagent.MySqlLockProbe;
import com.alibaba.qwen.code.managedagent.PublicationJournalFixture;
import com.alibaba.qwen.code.managedagent.artifact.ToolPublicationObjectStore;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.StoreModels;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels.AcquireWriterRequest;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels.AuthorizeLifecycleRequest;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels.BlockRecoveryRequest;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels.CommitResource;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels.CommitTransactionRequest;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels.RenewWriterRequest;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DelegatingDataSource;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.DefaultTransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.io.InputStream;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Witness for #13800: an externally held tenant guard row must not wedge
 * ordinary traffic of unrelated Sessions; admissions that legitimately
 * fence fail fast with a named error instead of out-waiting the caller.
 */
class ManagedSessionGuardConvoyIT {
    private static final ObjectMapper JSON = new ObjectMapper();
    // A bounded acquisition fails after one GUARD_ACQUIRE_TIMEOUT_SECONDS
    // (5 s) wait. The ceiling is a fixed number rather than a multiple of
    // that constant, so raising the bound past it turns these arms red.
    private static final long BOUNDED_FAILURE_CEILING_MS = 15_000;

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
        ManagedSchema.initialize(source);
    }

    @AfterEach
    void removeSchema() {
        if (admin != null && schema != null) {
            admin.execute("DROP DATABASE IF EXISTS " + schema);
        }
    }

    // The v2 probe must never borrow a second pooled connection from
    // inside a transaction that already holds one — at saturation the pool
    // self-deadlocks even across distinct tenants with zero database lock
    // contention. Capping the pool at two and releasing four concurrent
    // acquires at once reproduces the old shape: every transaction waits on
    // its second borrow until the pool wait budget lapses. On the caller's
    // own connection the probe costs nothing.
    @Test
    void poolSaturationDoesNotDeadlockConcurrentAcquiresAcrossTenants() throws Exception {
        String url = System.getProperty("mysql.url");
        String user = System.getProperty("mysql.user", "root");
        String password = System.getProperty("mysql.password", "");
        var pool = new DruidDataSource();
        pool.setUrl(url.replaceFirst("/[^/?]+(?=\\?|$)", "/" + schema));
        pool.setUsername(user);
        pool.setPassword(password);
        pool.setMaxActive(2);
        pool.setMaxWait(3_000L);
        String token = "w".repeat(32);
        try {
            var jdbc = new ManagedSchemaJdbcTemplate(pool);
            var manager = new DataSourceTransactionManager(pool);
            var transactions = new TransactionTemplate(manager);
            var store = new ManagedSessionStore(jdbc);
            int callers = 4;
            var ready = new CountDownLatch(callers);
            var release = new CountDownLatch(1);
            try (var threads = Executors.newFixedThreadPool(callers)) {
                var futures = new ArrayList<Future<?>>();
                for (int i = 0; i < callers; i++) {
                    String tenant = "tenant-sat-" + i;
                    futures.add(threads.submit(() -> {
                        ready.countDown();
                        release.await();
                        return transactions.execute(ignored -> store.acquireWriter(tenant, "sat", token,
                                new AcquireWriterRequest("workspace-sat", "writer-sat-" + tenant, 60_000L)));
                    }));
                }
                assertThat(ready.await(10, TimeUnit.SECONDS)).isTrue();
                release.countDown();
                for (var future : futures) {
                    assertThatCode(() -> future.get(30, TimeUnit.SECONDS)).doesNotThrowAnyException();
                }
            }
        } finally {
            pool.close();
        }
    }

    @Test
    void heldTenantGuardsDoNotWedgeUnrelatedSessions() throws Exception {
        var jdbc = new ManagedSchemaJdbcTemplate(source);
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
        jdbc.update("UPDATE ma_session_head SET recovery_status = 'BLOCKED_RESOURCE',"
                + " recovery_detail_code = 'a2-witness' WHERE tenant_id = ? AND session_id = ?"
                + " AND head_kind = 'MANAGED_SESSION'",
                tenant, "blocked");

        var holdTx = manager.getTransaction(new DefaultTransactionDefinition());
        try {
            // Hold both tenant-wide guards the way a fat lifecycle transaction
            // would, on a connection the test never commits.
            ToolPublicationRetentionStore.lockTenant(jdbc, tenant);
            WorkspaceLifecycleStore.lockPlacement(jdbc, tenant);
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
                blockedAgain.get(30, TimeUnit.SECONDS);

                // A record commit keeps bounded placement so it serializes
                // with lifecycle admissions (#13800 R2); under a held guard
                // it degrades to the named failure within the hot-path bound.
                long commitBefore = System.nanoTime();
                assertThatThrownBy(() -> committed.get(30, TimeUnit.SECONDS))
                        .isInstanceOf(ExecutionException.class)
                        .satisfies(error -> {
                            var cause = error.getCause();
                            assertThat(cause).isInstanceOf(ManagedAgentException.class);
                            assertThat(((ManagedAgentException) cause).getStatus())
                                    .isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
                            assertThat(((ManagedAgentException) cause).getCode())
                                    .isEqualTo("tenant_guard_contended");
                        });
                long commitElapsedMs = (System.nanoTime() - commitBefore) / 1_000_000;
                assertThat(commitElapsedMs).isLessThan(BOUNDED_FAILURE_CEILING_MS);
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
                            assertThat(cause).isInstanceOf(ManagedAgentException.class);
                            assertThat(((ManagedAgentException) cause).getStatus())
                                    .isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
                            assertThat(((ManagedAgentException) cause).getCode())
                                    .isEqualTo("tenant_guard_contended");
                        });
            }
            long elapsedMs = (System.nanoTime() - before) / 1_000_000;
            assertThat(elapsedMs).isLessThan(BOUNDED_FAILURE_CEILING_MS);

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
                            assertThat(cause).isInstanceOf(ManagedAgentException.class);
                            assertThat(((ManagedAgentException) cause).getStatus())
                                    .isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
                            assertThat(((ManagedAgentException) cause).getCode())
                                    .isEqualTo("tenant_guard_contended");
                        });
            }
            long lifecycleElapsedMs = (System.nanoTime() - lifecycleBefore) / 1_000_000;
            assertThat(lifecycleElapsedMs).isLessThan(BOUNDED_FAILURE_CEILING_MS);

            // A Turn submit admits through the same placement row on its
            // per-turn path, so it is bounded and named the same way.
            var agents = new ManagedAgentStore(jdbc, JSON, Clock.systemUTC(), ignored -> {},
                    new ManagedWorkspaceRegistry(jdbc), new ManagedAgentProperties());
            assertFastGuardFailure(() -> transactions.execute(ignored -> agents.insertTurnCommand(tenant,
                    "turn.submit", "submit-witness", "a".repeat(64), "victim", List.of(), "b".repeat(64))));
        } finally {
            manager.rollback(holdTx);
        }

        // The hold is gone; the same admission now succeeds.
        transactions.executeWithoutResult(ignored -> store.acquireWriter(tenant, "late", token,
                new AcquireWriterRequest(workspace, "writer-late", 60_000L)));
        // And the blocked neighbour reports its own blocked state unchanged.
        assertThat(jdbc.queryForObject("SELECT CONCAT(recovery_status, ':', recovery_detail_code) FROM"
                + " ma_session_head WHERE tenant_id = ? AND session_id = ? AND head_kind = 'MANAGED_SESSION'",
                String.class, tenant, "blocked")).isEqualTo("BLOCKED_RESOURCE:a2-witness");
    }

    private static String sha256(String value) throws NoSuchAlgorithmException {
        return HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));
    }

    /**
     * A duplicate commit parked behind the winner must replay the winner
     * once the winner commits: the retry's snapshot is only allowed to be
     * pinned after the head row is locked, or it misses the winner's
     * transaction and the duplicate surfaces a 409 (#13800 R1). Since R2
     * the duplicate parks at the commit's bounded placement guard first
     * (placement precedes the head lock on the commit path), so the wait
     * shows on the guard row, then the head FOR UPDATE runs unblocked
     * (#13800 R2).
     */
    @Test
    void duplicateCommitReplaysOnceTheWinnerReleasesItsGuards() throws Exception {
        var jdbc = new ManagedSchemaJdbcTemplate(source);
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
        // Roll the hold back on any failure path: a leaked transaction here
        // turns removeSchema's DROP DATABASE into an MDL hang.
        var winner = manager.getTransaction(new DefaultTransactionDefinition());
        try {
            var first = journalWriter.commit(request);
            try (var pool = Executors.newSingleThreadExecutor()) {
                var retry = pool.submit(() ->
                        transactions.execute(ignored -> journalWriter.commit(request)));
                awaitWaitingLock(jdbc, "ma_tenant_guard");
                manager.commit(winner);
                var second = retry.get(30, TimeUnit.SECONDS);
                assertThat(second.replayed()).isTrue();
                assertThat(second.journalRevision()).isEqualTo(first.journalRevision());
            }
        } finally {
            if (!winner.isCompleted()) {
                manager.rollback(winner);
            }
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_journal_tx"
                        + " WHERE tenant_id = ? AND session_id = ? AND operation = 'commitMcpRecord'",
                Integer.class, tenant, "victim")).isOne();
    }

    /**
     * Publication lanes take their first tenant-wide acquisition with the
     * hot-path bound: reserve (apply lane), prepareAdmission (admission
     * lane), producer/dispatch, commitReceipt (receipt lane's placement-first
     * entry) and publishToolResult (tool-result lane) all answer tenant_guard_contended
     * within the bound while a guard row is externally held, and complete
     * after the hold lifts (#13800 R1).
     */
    @Test
    void heldTenantGuardsBoundPublicationLaneEntries() throws Exception {
        var journal = PublicationJournalFixture.create(source, false);
        var jdbc = journal.jdbc;
        var manager = journal.manager;
        String tenant = "tenant-1";
        var key = journal.binding.get("sessionKey");

        var hold = manager.getTransaction(new DefaultTransactionDefinition());
        try {
            ToolPublicationRetentionStore.lockTenant(jdbc, tenant);
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
            public void validateConfiguration() {
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
        var execution = journal.executions.findByExecutionCallId("execution-1");
        hold = manager.getTransaction(new DefaultTransactionDefinition());
        try {
            WorkspaceLifecycleStore.lockPlacement(jdbc, tenant);
            assertFastGuardFailure(() -> journal.store.verifyDispatch(execution, "pub-1",
                    PublicationJournalFixture.PUBLICATION_TOKEN));
            assertFastGuardFailure(() -> data.finish(key, "pub-1",
                    PublicationJournalFixture.PUBLICATION_TOKEN, "finish",
                    envelope.toString().getBytes(StandardCharsets.UTF_8)));
        } finally {
            manager.rollback(hold);
        }
        assertThat(journal.store.verifyDispatch(execution, "pub-1",
                PublicationJournalFixture.PUBLICATION_TOKEN).path("publicationId").asText())
                .isEqualTo("pub-1");
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
        try {
            ToolPublicationRetentionStore.lockTenant(jdbc, tenant);
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
        try {
            WorkspaceLifecycleStore.lockPlacement(jdbc, tenant);
            assertFastGuardFailure(() ->
                    admission.commitReceipt(key, "pub-1", PublicationJournalFixture.WRITER_TOKEN,
                            request));
        } finally {
            manager.rollback(hold);
        }
        assertThat(admission.commitReceipt(key, "pub-1", PublicationJournalFixture.WRITER_TOKEN,
                request).path("historyRevision").asLong()).isEqualTo(sequence);

        // Tool-result publication takes the publication row behind bounded
        // placement: a held row answers named and fast there too.
        byte[] content = "tool output".getBytes(StandardCharsets.UTF_8);
        var publish = new ManagedSessionStoreModels.PublishToolResultRequest("workspace-1", "writer-1", 1,
                "result-content-1", "managed-tool-result-content", 1, content.length,
                ToolPublicationContract.sha256(content), Base64.getEncoder().encodeToString(content));
        var publications = new TransactionTemplate(manager);
        hold = manager.getTransaction(new DefaultTransactionDefinition());
        try {
            ToolPublicationRetentionStore.lockTenant(jdbc, tenant);
            assertFastGuardFailure(() -> publications.execute(ignored ->
                    journal.sessions.publishToolResult(tenant, "session-1",
                            PublicationJournalFixture.WRITER_TOKEN, publish)));
        } finally {
            manager.rollback(hold);
        }
        ManagedSessionStoreModels.ToolResultResourceRef published = publications.execute(ignored ->
                journal.sessions.publishToolResult(tenant, "session-1", PublicationJournalFixture.WRITER_TOKEN,
                        publish));
        assertThat(published.resourceId()).isEqualTo("result-content-1");
    }

    @Test
    void heldSessionRowsBoundRetentionReads() throws Exception {
        var journal = PublicationJournalFixture.create(source, false);
        var retention = new ToolPublicationRetentionStore(journal.jdbc, journal.manager);
        try (var lease = retention.read("tenant-1", "session-1")) {
            lease.check();
        }

        for (String table : List.of("ma_session", "ma_session_head")) {
            var hold = journal.manager.getTransaction(new DefaultTransactionDefinition());
            try {
                if ("ma_session".equals(table)) {
                    journal.sessions.renewWriter("tenant-1", "session-1", PublicationJournalFixture.WRITER_TOKEN,
                            new RenewWriterRequest("workspace-1", "writer-1", 1, 60_000L));
                } else {
                    journal.jdbc.query("SELECT session_id FROM ma_session_head"
                                    + " WHERE tenant_id = ? AND session_id = ? FOR UPDATE",
                            (row, index) -> row.getString("session_id"), "tenant-1", "session-1");
                }
                assertFastGuardFailure(() -> retention.read("tenant-1", "session-1"));
            } finally {
                journal.manager.rollback(hold);
            }
            try (var lease = retention.read("tenant-1", "session-1")) {
                lease.check();
            }
            assertThat(journal.jdbc.queryForObject("SELECT COUNT(*) FROM ma_read_lease", Integer.class)).isZero();
        }
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
        var jdbc = new ManagedSchemaJdbcTemplate(source);
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
        try {
            WorkspaceLifecycleStore.lockPlacement(jdbc, tenant);
            long deadlocksBefore = MySqlLockProbe.innodbDeadlocks(jdbc);
            try (var pool = Executors.newSingleThreadExecutor()) {
                var writer = pool.submit(() -> transactions.executeWithoutResult(ignored ->
                        store.acquireWriter(tenant, "victim", token,
                                new AcquireWriterRequest(workspace, "writer-victim", 60_000L))));
                awaitWaitingLock(jdbc, "ma_tenant_guard");
                // The begin path's drain insert must complete inside the same
                // transaction window: a drain-first writer order would have the
                // writer holding this gap and deadlock the pair.
                jdbc.update("INSERT INTO ma_session_head (tenant_key, harness_key, tenant_id,"
                                + " harness_session_id, session_id, head_kind, phase, gmt_create, gmt_modified)"
                                + " VALUES (?, ?, ?, ?, ?, 'HARNESS', 'DRAINING', " + ManagedSchemaTime.SQL_NOW + ", "
                                + ManagedSchemaTime.SQL_NOW + ")"
                                + " ON DUPLICATE KEY UPDATE phase = 'DRAINING', claim_lease_until = NULL",
                        JdbcRuntimeBindingRepository.harnessDrainKey(tenant),
                        JdbcRuntimeBindingRepository.harnessDrainKey("victim"), tenant, "victim", "victim");
                manager.rollback(lifecycle);
                // Collected only after the rollback: until then the writer is
                // parked on the placement row the hold owns. A deadlock victim
                // or a lock-wait timeout surfaces here.
                assertThatCode(() -> writer.get(30, TimeUnit.SECONDS)).doesNotThrowAnyException();
                assertThat(MySqlLockProbe.innodbDeadlocks(jdbc) - deadlocksBefore)
                        .as("no InnoDB deadlock must form between lifecycle placement and writer admission")
                        .isZero();
            }
        } finally {
            if (!lifecycle.isCompleted()) {
                manager.rollback(lifecycle);
            }
        }
        // A real lifecycle would commit the drain instead of rolling it
        // back; replay that final state explicitly.
        transactions.executeWithoutResult(ignored ->
                jdbc.update("INSERT INTO ma_session_head (tenant_key, harness_key, tenant_id,"
                                + " harness_session_id, session_id, head_kind, phase, gmt_create, gmt_modified)"
                                + " VALUES (?, ?, ?, ?, ?, 'HARNESS', 'DRAINING', " + ManagedSchemaTime.SQL_NOW + ", "
                                + ManagedSchemaTime.SQL_NOW + ")"
                                + " ON DUPLICATE KEY UPDATE phase = 'DRAINING', claim_lease_until = NULL",
                        JdbcRuntimeBindingRepository.harnessDrainKey(tenant),
                        JdbcRuntimeBindingRepository.harnessDrainKey("victim"), tenant, "victim", "victim"));
        assertThatThrownBy(() -> transactions.executeWithoutResult(ignored ->
                store.acquireWriter(tenant, "victim", token,
                        new AcquireWriterRequest(workspace, "writer-victim", 60_000L))))
                .isInstanceOf(ManagedAgentException.class)
                .satisfies(error -> {
                    assertThat(((ManagedAgentException) error).getStatus()).isEqualTo(HttpStatus.CONFLICT);
                    assertThat(((ManagedAgentException) error).getCode())
                            .isEqualTo("managed_session_lifecycle_active");
                });
        transactions.executeWithoutResult(ignored -> store.acquireWriter(tenant, "neighbor",
                token, new AcquireWriterRequest(workspace, "writer-neighbor", 60_000L)));
    }

    /**
     * Writer acquisition must hold the Session root exclusively before an
     * ordinary writer can queue on it. The acquisition pauses after
     * the acquisition's first root UPSERT, then an ordinary blockRecovery of the
     * same Session queues on the root; releasing the pause must let both
     * complete without an InnoDB deadlock.
     */
    @Test
    void writerAcquisitionHoldsTheSessionRootExclusivelyAgainstOrdinaryWriters() throws Exception {
        assertNoDeadlockAgainstOrdinaryWriter("INSERT INTO ma_session (",
                (store, grant) -> store.acquireWriter(TENANT, "victim", TOKEN,
                        new AcquireWriterRequest(WORKSPACE, "writer-victim", 60_000L)));
    }

    /**
     * Ordinary authorisation reads the drain admission off the head row;
     * it must lock the Session root before that read, or it holds the head
     * while waiting for the root that an ordinary writer holds while
     * waiting for the head (#13800).
     */
    @Test
    void ordinaryAuthorizationLocksTheSessionRootBeforeTheHead() throws Exception {
        assertNoDeadlockAgainstOrdinaryWriter("SELECT phase FROM ma_session_head WHERE phase <> 'OPEN'",
                (store, grant) -> {
                    store.authorizeOrdinary(TENANT, "victim", TOKEN,
                            new AuthorizeLifecycleRequest(WORKSPACE, "writer-victim", grant.writerGeneration()));
                    return null;
                });
    }

    @Test
    void heldPublicationGuardBoundsLifecycleCompletion() throws Exception {
        var fixture = new WorkspaceLifecycleStoreTest.Fixture(source);
        String operationId = fixture.transactions.execute(ignored -> fixture.store.beginWorkspaceLifecycle(
                "tenant", fixture.session, StoreModels.OperationKind.CLOSE, "owner", "a".repeat(64),
                "close", "digest", true, 1).operation().operationId());
        var operation = fixture.transactions.execute(ignored -> fixture.store.claimOperation(
                "tenant", fixture.session, operationId, "worker", Duration.ofMinutes(5)).orElseThrow());
        var effects = fixture.transactions.execute(ignored -> fixture.lifecycle.recoverEffects(operation));
        assertThat(effects.path("neverInitialized").asBoolean()).isTrue();
        var before = fixture.store.findOperation("tenant", fixture.session, operationId).orElseThrow();
        var manager = new DataSourceTransactionManager(source);
        var hold = manager.getTransaction(new DefaultTransactionDefinition());
        try {
            ToolPublicationRetentionStore.lockTenant(fixture.jdbc, "tenant");
            assertFastGuardFailure(() -> fixture.transactions.execute(ignored -> fixture.store.completeOperation(
                    "tenant", fixture.session, operationId, "worker", operation.claimGeneration(), true)));
            assertThat(fixture.store.findOperation("tenant", fixture.session, operationId).orElseThrow())
                    .isEqualTo(before);
            assertThat(fixture.store.requireSession("tenant", fixture.session).status()).isEqualTo("CLOSING");
        } finally {
            manager.rollback(hold);
        }
        assertThat(fixture.transactions.<Boolean>execute(ignored -> fixture.store.completeOperation(
                "tenant", fixture.session, operationId, "worker", operation.claimGeneration(), true))).isTrue();
        assertThat(fixture.store.requireSession("tenant", fixture.session).status()).isEqualTo("CLOSED");
        var completed = fixture.store.findOperation("tenant", fixture.session, operationId).orElseThrow();
        assertThat(completed.state()).isEqualTo("COMPLETED");
        assertThat(completed.deliveryState()).isEqualTo("CONFIRMED");
        assertThat(completed.receiptId()).isNotBlank();
        assertThat(fixture.jdbc.queryForObject(
                "SELECT COUNT(*) FROM ma_public_event WHERE tenant_id = ? AND session_id = ? AND event_type = 'session.closed'",
                Integer.class, "tenant", fixture.session)).isEqualTo(1);
    }

    private static final String TENANT = "tenant-a";
    private static final String WORKSPACE = "workspace-a";
    private static final String TOKEN = "w".repeat(32);

    private interface PausedCall {
        Object run(ManagedSessionStore store, ManagedSessionStoreModels.WriterGrant grant);
    }

    private void assertNoDeadlockAgainstOrdinaryWriter(String trigger, PausedCall paused) throws Exception {
        var pausing = new PauseAfterDataSource(source, trigger);
        var jdbc = new ManagedSchemaJdbcTemplate(pausing);
        var transactions = new TransactionTemplate(new DataSourceTransactionManager(pausing));
        var store = new ManagedSessionStore(jdbc);
        var grant = transactions.execute(ignored -> store.acquireWriter(TENANT, "victim", TOKEN,
                new AcquireWriterRequest(WORKSPACE, "writer-victim", 60_000L)));
        long deadlocksBefore = MySqlLockProbe.innodbDeadlocks(jdbc);
        try (var pausedThread = Executors.newSingleThreadExecutor(task -> new Thread(task, "paused"));
                var ordinaryThread = Executors.newSingleThreadExecutor()) {
            pausing.enabled = true;
            var pausedCall = pausedThread.submit(() -> transactions.execute(ignored -> paused.run(store, grant)));
            assertThat(pausing.reached.await(10, TimeUnit.SECONDS)).isTrue();
            var ordinary = ordinaryThread.submit(() -> transactions.execute(ignored ->
                    store.blockRecovery(TENANT, "victim", TOKEN, new BlockRecoveryRequest(WORKSPACE,
                            "writer-victim", grant.writerGeneration(), "BLOCKED_RESOURCE", "root-order"))));
            MySqlLockProbe.awaitLockWaits(jdbc, schema, 1, "the ordinary writer");
            pausing.release.countDown();
            assertThatCode(() -> pausedCall.get(30, TimeUnit.SECONDS)).doesNotThrowAnyException();
            assertThatCode(() -> ordinary.get(30, TimeUnit.SECONDS)).doesNotThrowAnyException();
        } finally {
            pausing.release.countDown();
        }
        assertThat(MySqlLockProbe.innodbDeadlocks(jdbc) - deadlocksBefore)
                .as("ordinary writers and the paused call must not form an InnoDB deadlock")
                .isZero();
    }

    /** Pauses the thread named "paused" right after its first statement that starts with the trigger. */
    private static final class PauseAfterDataSource extends DelegatingDataSource {
        private final String trigger;
        private final CountDownLatch reached = new CountDownLatch(1);
        private final CountDownLatch release = new CountDownLatch(1);
        private final AtomicBoolean fired = new AtomicBoolean();
        private volatile boolean enabled;

        private PauseAfterDataSource(DataSource source, String trigger) {
            super(source);
            this.trigger = trigger;
        }

        @Override
        public Connection getConnection() throws SQLException {
            return wrap(super.getConnection());
        }

        @Override
        public Connection getConnection(String user, String password) throws SQLException {
            return wrap(super.getConnection(user, password));
        }

        private Connection wrap(Connection connection) {
            return (Connection) Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[] {Connection.class},
                    (proxy, method, args) -> {
                        try {
                            Object result = method.invoke(connection, args);
                            if (!method.getName().equals("prepareStatement")
                                    || !(result instanceof PreparedStatement statement)) {
                                return result;
                            }
                            String sql = (String) args[0];
                            return Proxy.newProxyInstance(getClass().getClassLoader(),
                                    new Class<?>[] {PreparedStatement.class}, (prepared, call, values) -> {
                                        try {
                                            Object value = call.invoke(statement, values);
                                            if (enabled && call.getName().startsWith("execute")
                                                    && "paused".equals(Thread.currentThread().getName())
                                                    && sql.startsWith(trigger) && fired.compareAndSet(false, true)) {
                                                reached.countDown();
                                                if (!release.await(30, TimeUnit.SECONDS)) {
                                                    throw new AssertionError("Paused call was never released");
                                                }
                                            }
                                            return value;
                                        } catch (InvocationTargetException error) {
                                            throw error.getCause();
                                        }
                                    });
                        } catch (InvocationTargetException error) {
                            throw error.getCause();
                        }
                    });
        }
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

    private static void assertFastGuardFailure(Callable<Object> action) throws Exception {
        long before = System.nanoTime();
        try (var pool = Executors.newSingleThreadExecutor()) {
            assertThatThrownBy(() -> pool.submit(action).get(30, TimeUnit.SECONDS))
                    .isInstanceOf(ExecutionException.class)
                    .satisfies(error -> {
                        var cause = error.getCause();
                        assertThat(cause).isInstanceOf(ManagedAgentException.class);
                        assertThat(((ManagedAgentException) cause).getStatus())
                                .isEqualTo(HttpStatus.SERVICE_UNAVAILABLE);
                        assertThat(((ManagedAgentException) cause).getCode())
                                .isEqualTo("tenant_guard_contended");
                    });
        }
        long elapsedMs = (System.nanoTime() - before) / 1_000_000;
        assertThat(elapsedMs).isLessThan(BOUNDED_FAILURE_CEILING_MS);
    }
}
