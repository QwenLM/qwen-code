package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.AcquireWriterRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.CommitResource;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.CommitTransactionRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.SealWriterRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationAdmissionStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationDataStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationObjectStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationRetentionStore;
import com.alibaba.qwen.code.managedagent.store.WorkspaceCsiRegistration;
import com.alibaba.qwen.code.managedagent.store.WorkspaceCsiReservationStore;
import com.alibaba.qwen.code.managedagent.store.WorkspaceCsiSessionMain;
import com.alibaba.qwen.code.managedagent.store.WorkspaceLifecycleStore;
import com.alibaba.qwen.code.runtimebroker.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.CsiFilesRetirementProfile;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DelegatingDataSource;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.io.InputStream;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import static com.alibaba.qwen.code.managedagent.PublicationJournalFixture.COMMIT_MARKER;
import static com.alibaba.qwen.code.managedagent.PublicationJournalFixture.PUBLICATION_TOKEN;
import static com.alibaba.qwen.code.managedagent.PublicationJournalFixture.WRITER_TOKEN;
import static com.alibaba.qwen.code.managedagent.PublicationJournalFixture.digest;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ToolPublicationLockOrderMySqlIT {
    private static final ObjectMapper JSON = new ObjectMapper();

    @ParameterizedTest
    @CsvSource({"reserve,false", "reserve,true", "renew,false", "renew,true"})
    void publicationSeesJournalCommittedAfterPlacementDiscovery(String operation, boolean headAuthorization) throws Exception {
        String url = System.getProperty("mysql.url");
        if (url == null || !url.matches("jdbc:mysql://[^/]+/[^?]+(?:\\?.*)?")) {
            throw new IllegalArgumentException("A MySQL test database URL is required");
        }
        String user = System.getProperty("mysql.user");
        String password = System.getProperty("mysql.password", "");
        var admin = new JdbcTemplate(new DriverManagerDataSource(url, user, password));
        String schema = "publication_snapshot_" + UUID.randomUUID().toString().replace("-", "");
        admin.execute("CREATE DATABASE " + schema);
        try {
            var source = new OwnerPauseDataSource(new DriverManagerDataSource(
                    url.replaceFirst("/[^/?]+(?=\\?|$)", "/" + schema), user, password));
            Flyway.configure().dataSource(source).locations("classpath:db/managed-schema").load().migrate();
            var journal = PublicationJournalFixture.create(source, headAuthorization);
            if ("renew".equals(operation)) {
                journal.reserve();
            }
            try (var writer = Executors.newSingleThreadExecutor()) {
                source.afterSnapshot = () -> {
                    try {
                        writer.submit(() -> journal.append("renewActivation", journal.event(journal.sequence + 1,
                                "activation.changed", PublicationJournalFixture.activation("active")) + COMMIT_MARKER,
                                1, List.of(), null)).get(30, TimeUnit.SECONDS);
                    } catch (Exception failure) {
                        throw new AssertionError("Concurrent activation renewal failed", failure);
                    }
                };
                JsonNode granted = journal.store.apply(journal.request(operation), WRITER_TOKEN, PUBLICATION_TOKEN);
                assertThat(source.snapshotRead).isTrue();
                assertThat(granted.path("state").asText()).isEqualTo("OPEN");
                assertThat(journal.jdbc.queryForObject("SELECT journal_revision FROM ma_session_head"
                        + " WHERE tenant_id = 'tenant-1' AND harness_session_id = 'session-1'", Long.class))
                        .isEqualTo(journal.revision);
            }
        } finally {
            admin.execute("DROP DATABASE " + schema);
        }
    }

    /**
     * A placement owner pauses after the tenant placement guard. Each publication path must wait for
     * placement before it retains the publication tenant row, or the owner's retention request closes a
     * placement/retention cycle. Standalone admission and renew are the shapes the HTTP controller uses.
     */
    @ParameterizedTest
    @ValueSource(strings = {"receipt", "admission-and-receipt", "admission", "renew", "ambient-renew"})
    void publicationTakesPlacementBeforeRetention(String operation) throws Exception {
        String url = System.getProperty("mysql.url");
        if (url == null || !url.matches("jdbc:mysql://[^/]+/[^?]+(?:\\?.*)?")) {
            throw new IllegalArgumentException("A MySQL test database URL is required");
        }
        String user = System.getProperty("mysql.user");
        String password = System.getProperty("mysql.password", "");
        var admin = new JdbcTemplate(new DriverManagerDataSource(url, user, password));
        String schema = "publication_lock_order_" + UUID.randomUUID().toString().replace("-", "");
        admin.execute("CREATE DATABASE " + schema);
        try {
            var source = new OwnerPauseDataSource(new DriverManagerDataSource(
                    url.replaceFirst("/[^/?]+(?=\\?|$)", "/" + schema), user, password));
            Flyway.configure().dataSource(source).locations("classpath:db/managed-schema").load().migrate();
            var journal = PublicationJournalFixture.create(source, false);
            JsonNode reserved = journal.reserve();
            var transaction = new TransactionTemplate(journal.manager);
            if (operation.endsWith("renew")) {
                boolean ambient = operation.startsWith("ambient");
                JsonNode renewed = contend(source, admin, schema, journal, () -> ambient
                        ? transaction.execute(status -> journal.store.apply(journal.request("renew"),
                                WRITER_TOKEN, PUBLICATION_TOKEN))
                        : journal.store.apply(journal.request("renew"), WRITER_TOKEN, PUBLICATION_TOKEN));
                assertThat(renewed.path("state").asText()).isEqualTo(reserved.path("state").asText());
                return;
            }
            boolean prepareInSameTransaction = "admission-and-receipt".equals(operation);
            var jdbc = journal.jdbc;
            ToolPublicationObjectStore objects = new ToolPublicationObjectStore() {
                @Override
                public void putIfAbsent(String key, byte[] bytes) {
                    throw new AssertionError("Inline fixture expected");
                }
                @Override
                public InputStream open(String key) {
                    throw new AssertionError("Inline fixture expected");
                }
                @Override
                public void validateConfiguration() {}
            };
            var data = new ToolPublicationDataStore(jdbc, journal.manager, journal.store, journal.sessions,
                    objects, Duration.ofMinutes(2), Duration.ofSeconds(30),
                    new ToolPublicationDataStore.VerificationBudget(16 * 1024 * 1024, Duration.ofMinutes(25)));
            var key = journal.binding.get("sessionKey");
            var envelope = JSON.createObjectNode().put("executionStatus", "error");
            envelope.putArray("responseParts");
            envelope.set("capture", JSON.createObjectNode().put("captureStatus", "unavailable")
                    .put("captureReason", "storage_failed").put("previewTruncated", false)
                    .put("deliveryStatus", "pending").putNull("manifest"));
            data.finish(key, "pub-1", PUBLICATION_TOKEN, "finish", envelope.toString().getBytes(StandardCharsets.UTF_8));
            var outcome = JSON.createObjectNode().put("schemaVersion", 1).put("decision", "blocked").putNull("manifestRef");
            outcome.set("envelope", envelope);
            var history = JSON.createObjectNode().put("messageId", "11111111-1111-4111-8111-111111111111")
                    .put("timestamp", "2026-10-11T00:00:00Z").put("model", "test");
            history.putArray("parts").addObject().put("text", "Shell capture unavailable");
            outcome.set("history", history);
            if ("admission".equals(operation)) {
                JsonNode admitted = contend(source, admin, schema, journal,
                        () -> data.prepareAdmission(key, "pub-1", "writer-1", 1, WRITER_TOKEN, outcome));
                assertThat(data.prepareAdmission(key, "pub-1", "writer-1", 1, WRITER_TOKEN, outcome))
                        .isEqualTo(admitted);
                return;
            }
            // Admission roots are deterministic, so a rolled-back preparation recreates the same reference.
            JsonNode root = transaction.execute(status -> {
                JsonNode prepared = data.prepareAdmission(key, "pub-1", "writer-1", 1, WRITER_TOKEN, outcome);
                if (prepareInSameTransaction) {
                    status.setRollbackOnly();
                }
                return prepared;
            });
            long sequence = journal.sequence + 1;
            var payload = JSON.createObjectNode().put("executionCallId", "execution-1")
                    .put("historyRevision", sequence).putNull("resultRef");
            payload.set("toolOutcomeRef", root);
            payload.putArray("resources");
            String records = journal.event(sequence, "tool.receipt", payload) + COMMIT_MARKER;
            var request = new CommitTransactionRequest("workspace-1", "writer-1", 1, journal.revision,
                    journal.sequence, "receipt", "recordToolResult", "execution-1", root.path("digest").asText(),
                    sequence, sequence, 1, digest(records), journal.commitDigest, digest(records), 1, null, 2,
                    Base64.getEncoder().encodeToString(records.getBytes(StandardCharsets.UTF_8)), digest(records),
                    List.of(new CommitResource(root.path("resourceId").asText(), "managed-tool-outcome", 1,
                            root.path("byteLength").asLong(), root.path("digest").asText(), null)));
            var admission = new ToolPublicationAdmissionStore(jdbc, journal.manager, journal.sessions, data);
            JsonNode receipt = contend(source, admin, schema, journal, () -> transaction.execute(status -> {
                if (prepareInSameTransaction) {
                    assertThat(data.prepareAdmission(key, "pub-1", "writer-1", 1, WRITER_TOKEN, outcome))
                            .isEqualTo(root);
                }
                return admission.commitReceipt(key, "pub-1", WRITER_TOKEN, request);
            }));
            assertThat(receipt.path("decision").asText()).isEqualTo("blocked");
            JsonNode replay = admission.commitReceipt(key, "pub-1", WRITER_TOKEN, request);
            assertThat(replay).isEqualTo(receipt);
            assertThat(journal.sessions.readResource("tenant-1", "workspace-1", "session-1",
                    root.path("resourceId").asText(), WRITER_TOKEN).bytes())
                    .isEqualTo(outcome.toString().getBytes(StandardCharsets.UTF_8));
        } finally {
            admin.execute("DROP DATABASE " + schema);
        }
    }

    /**
     * The CSI writer lane takes root → placement → retention on a pinned
     * Session (#13800), while every other lane, the retention lane through
     * {@code ToolPublicationRetentionStore.lockSessionHead} among them,
     * takes the tenant CAS row before the root. On one pinned Session the
     * two orders close an InnoDB cycle (#13800 R1-1). The subject here is
     * the heavier transaction, so InnoDB rolls back the retention owner at
     * its root wait: that victim must answer the named, retryable
     * tenant_guard_contended like the guard side, never a raw deadlock,
     * and the seal then completes (its answer on the pinned original
     * itself is csi_finalize_required). Dropping the root-side mapping
     * turns the owner's failure back into a DeadlockLoserDataAccessException.
     */
    @Test
    void pinnedSessionDeadlockNamesTheRetentionVictim() throws Exception {
        String url = System.getProperty("mysql.url");
        if (url == null || !url.matches("jdbc:mysql://[^/]+/[^?]+(?:\\?.*)?")) {
            throw new IllegalArgumentException("A MySQL test database URL is required");
        }
        String user = System.getProperty("mysql.user");
        String password = System.getProperty("mysql.password", "");
        var admin = new JdbcTemplate(new DriverManagerDataSource(url, user, password));
        String schema = "seal_lock_order_" + UUID.randomUUID().toString().replace("-", "");
        admin.execute("CREATE DATABASE " + schema);
        try {
            var source = new OwnerPauseDataSource(new DriverManagerDataSource(
                    url.replaceFirst("/[^/?]+(?=\\?|$)", "/" + schema), user, password));
            Flyway.configure().dataSource(source).locations("classpath:db/managed-schema").load().migrate();
            var jdbc = new com.alibaba.qwen.code.managedagent.store.ManagedSchemaJdbcTemplate(source);
            var manager = new DataSourceTransactionManager(source);
            var registration = new WorkspaceCsiRegistration("tenant", "storage", "cluster", "ns",
                    "pvc", "pvc-uid", "pv", "pv-uid", "disk.csi.example.com", "volume", "backend",
                    "disk-serial", "/workspace", 7);
            var reservations = new WorkspaceCsiReservationStore(jdbc, manager, JSON);
            reservations.register(registration);
            jdbc.update(
                    "INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation,"
                        + " storage_id, display_name, config_ref, policy_ref, state) VALUES"
                        + " ('tenant', 'workspace', 3, 'storage', 'CSI', ?, ?, 'ACTIVE')",
                    CsiFilesRetirementProfile.CONFIG_REF, CsiFilesRetirementProfile.POLICY_REF);
            jdbc.update(
                    "INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role)"
                        + " VALUES ('tenant', 'workspace', ?, 'OPERATOR')",
                    ManagedWorkspaceRegistry.actorKey("tenant", "actor"));
            var properties = new ManagedAgentProperties();
            properties.setAgentRevision("reviewed-agent/1");
            // A full pinned original: the seal below walks the whole CSI
            // lane (root → placement → retention) before the contract
            // names its own refusal, csi_finalize_required.
            String sessionId = createCsiOriginal(jdbc, manager, JSON, properties, registration);
            var bindings = new JdbcRuntimeBindingRepository(source,
                    new AesGcmSecretProtector("test", new byte[32]));
            var managed = new ManagedAgentStore(jdbc, JSON, Clock.systemUTC(), ignored -> {},
                    new ManagedWorkspaceRegistry(jdbc), properties);
            var transaction = new TransactionTemplate(manager);
            var request = transaction.execute(status ->
                    requireCsiRequest(managed, registration, sessionId));
            var binding = bindings.findOrCreate(request);
            binding = bindings.claimOperation(binding.getBindingId(), "operator",
                    Duration.ofSeconds(120));
            reservations.reserve(registration, bindings, binding, UUID.randomUUID().toString());
            var seed = binding.getProvisionSeed();
            bindings.compareAndSet(binding, binding.withAttestation(
                    new RuntimeLease(seed.getProvisionalRuntimeId(),
                            URI.create("https://original.example.invalid"), seed.getToken(),
                            seed.getLeaseId(), seed.getEpoch()),
                    new RuntimeResourceHandle("kubernetes-workspace", 3,
                            Map.of("podUid", "fixture-original")),
                    Instant.now(), Instant.now()));
            var sessions = new ManagedSessionStore(jdbc);
            transaction.executeWithoutResult(status -> sessions.acquireWriter("tenant", sessionId,
                    WRITER_TOKEN, new AcquireWriterRequest("workspace", "writer", 60_000L)));
            // InnoDB rolls back the transaction with the smaller undo log;
            // these rows make the seal the heavier side of the cycle.
            jdbc.execute("CREATE TABLE deadlock_weight (id INT PRIMARY KEY)");
            long deadlocksBefore = MySqlLockProbe.innodbDeadlocks(admin);
            var owners = Executors.newSingleThreadExecutor(task -> new Thread(task, "owner"));
            var subjects = Executors.newSingleThreadExecutor(task -> new Thread(task, "subject"));
            try {
                source.enabled = true;
                source.pauseOwnerOnFirstInsert = true;
                var owner = owners.submit(() -> transaction.executeWithoutResult(
                        status -> lockSessionHead(jdbc, "tenant", sessionId)));
                assertThat(source.ownerFirstLock.await(10, TimeUnit.SECONDS))
                        .as("Retention owner holds the tenant CAS row").isTrue();
                var subject = subjects.submit(() -> transaction.execute(status -> {
                    for (int row = 0; row < 200; row++) {
                        jdbc.update("INSERT INTO deadlock_weight (id) VALUES (?)", row);
                    }
                    return sessions.sealWriter("tenant", sessionId, WRITER_TOKEN,
                            new SealWriterRequest("workspace", "writer", 1), null);
                }));
                long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
                while (MySqlLockProbe.lockWaits(admin, schema) == 0 && !subject.isDone()) {
                    assertThat(System.nanoTime()).isLessThan(deadline);
                    Thread.sleep(200);
                }
                source.releaseOwner.countDown();
                assertThatThrownBy(() -> owner.get(30, TimeUnit.SECONDS))
                        .as("The retention owner is the deadlock victim at its root wait")
                        .isInstanceOf(ExecutionException.class)
                        .cause().isInstanceOfSatisfying(ApiException.class, error -> {
                            assertThat(error.getStatus().value()).isEqualTo(503);
                            assertThat(error.getCode()).isEqualTo("tenant_guard_contended");
                        });
                assertThatThrownBy(() -> subject.get(30, TimeUnit.SECONDS))
                        .isInstanceOf(ExecutionException.class)
                        .cause().isInstanceOfSatisfying(ApiException.class, error ->
                                assertThat(error.getCode()).isEqualTo("csi_finalize_required"));
                assertThat(source.subjectPlacementLocks.get())
                        .as("Sealed CSI writer walked root → placement → retention"
                            + " (the second placement is lockManagedSession's own domain)")
                        .containsExactly("root", "placement", "retention", "placement");
                assertThat(MySqlLockProbe.innodbDeadlocks(admin) - deadlocksBefore)
                        .as("The two orders formed an InnoDB cycle").isPositive();
            } finally {
                source.releaseOwner.countDown();
                source.enabled = false;
                // Let both transactions end before the schema is dropped.
                owners.shutdown();
                subjects.shutdown();
                assertThat(owners.awaitTermination(60, TimeUnit.SECONDS)
                        && subjects.awaitTermination(60, TimeUnit.SECONDS)).isTrue();
            }
        } finally {
            admin.execute("DROP DATABASE " + schema);
        }
    }

    /**
     * On an ordinary Session every lane that holds the tenant CAS row
     * reaches the Session root only after it: a publication renew takes
     * placement → CAS → root, and the retention lane takes CAS → root.
     * Taking the root first on the retention side (an earlier answer to
     * #13800 R1-1) closes a cycle with every such lane on every Session,
     * not only on pinned ones: the paused retention owner would hold the
     * root while the renew holds CAS. Here both complete with no deadlock.
     */
    @Test
    void ordinaryPublicationBesideARetentionOwnerDoesNotDeadlock() throws Exception {
        String url = System.getProperty("mysql.url");
        if (url == null || !url.matches("jdbc:mysql://[^/]+/[^?]+(?:\\?.*)?")) {
            throw new IllegalArgumentException("A MySQL test database URL is required");
        }
        String user = System.getProperty("mysql.user");
        String password = System.getProperty("mysql.password", "");
        var admin = new JdbcTemplate(new DriverManagerDataSource(url, user, password));
        String schema = "retention_lock_order_" + UUID.randomUUID().toString().replace("-", "");
        admin.execute("CREATE DATABASE " + schema);
        try {
            var source = new OwnerPauseDataSource(new DriverManagerDataSource(
                    url.replaceFirst("/[^/?]+(?=\\?|$)", "/" + schema), user, password));
            Flyway.configure().dataSource(source).locations("classpath:db/managed-schema").load().migrate();
            var journal = PublicationJournalFixture.create(source, false);
            JsonNode reserved = journal.reserve();
            var transaction = new TransactionTemplate(journal.manager);
            long deadlocksBefore = MySqlLockProbe.innodbDeadlocks(admin);
            var owners = Executors.newSingleThreadExecutor(task -> new Thread(task, "owner"));
            var subjects = Executors.newSingleThreadExecutor(task -> new Thread(task, "subject"));
            try {
                source.enabled = true;
                source.pauseOwnerOnFirstInsert = true;
                var owner = owners.submit(() -> transaction.executeWithoutResult(
                        status -> lockSessionHead(journal.jdbc, "tenant-1", "session-1")));
                assertThat(source.ownerFirstLock.await(10, TimeUnit.SECONDS))
                        .as("Retention owner holds its first row").isTrue();
                var subject = subjects.submit(() -> journal.store.apply(journal.request("renew"),
                        WRITER_TOKEN, PUBLICATION_TOKEN));
                MySqlLockProbe.awaitLockWaits(admin, schema, 1, "the publication renew");
                source.releaseOwner.countDown();
                owner.get(30, TimeUnit.SECONDS);
                JsonNode renewed = subject.get(30, TimeUnit.SECONDS);
                assertThat(renewed.path("state").asText()).isEqualTo(reserved.path("state").asText());
                assertThat(MySqlLockProbe.innodbDeadlocks(admin) - deadlocksBefore)
                        .as("Retention and publication agree on CAS before root").isZero();
            } finally {
                source.releaseOwner.countDown();
                source.enabled = false;
                owners.shutdown();
                subjects.shutdown();
                assertThat(owners.awaitTermination(60, TimeUnit.SECONDS)
                        && subjects.awaitTermination(60, TimeUnit.SECONDS)).isTrue();
            }
        } finally {
            admin.execute("DROP DATABASE " + schema);
        }
    }

    /**
     * {@code WorkspaceCsiSessionMain.create} is package-scoped like the
     * retention entry point; the arm drives the production fixture path
     * reflectively rather than through a test-only API.
     */
    private static String createCsiOriginal(JdbcTemplate jdbc,
            PlatformTransactionManager manager, ObjectMapper json,
            ManagedAgentProperties properties, WorkspaceCsiRegistration registration) {
        try {
            var create = WorkspaceCsiSessionMain.class.getDeclaredMethod("create",
                    JdbcTemplate.class, PlatformTransactionManager.class, ObjectMapper.class,
                    ManagedAgentProperties.class, WorkspaceCsiSessionMain.Request.class);
            create.setAccessible(true);
            var created = create.invoke(null, jdbc, manager, json, properties,
                    new WorkspaceCsiSessionMain.Request(registration, "actor", "create", null, null,
                            new WorkspaceSelection("workspace", ".")));
            var sessionId = created.getClass().getDeclaredMethod("sessionId");
            sessionId.setAccessible(true);
            return (String) sessionId.invoke(created);
        } catch (InvocationTargetException error) {
            if (error.getCause() instanceof RuntimeException runtime) {
                throw runtime;
            }
            throw new AssertionError(error.getCause());
        } catch (ReflectiveOperationException error) {
            throw new AssertionError(error);
        }
    }

    /** Same package-scoped entry, for the reservation's provision request. */
    private static RuntimeProvisionRequest requireCsiRequest(ManagedAgentStore managed,
            WorkspaceCsiRegistration registration, String sessionId) {
        try {
            var method = ManagedAgentStore.class.getDeclaredMethod("requireCsiRequest",
                    WorkspaceCsiRegistration.class, String.class);
            method.setAccessible(true);
            return (RuntimeProvisionRequest) method.invoke(managed, registration, sessionId);
        } catch (InvocationTargetException error) {
            if (error.getCause() instanceof RuntimeException runtime) {
                throw runtime;
            }
            throw new AssertionError(error.getCause());
        } catch (ReflectiveOperationException error) {
            throw new AssertionError(error);
        }
    }

    /**
     * {@code lockSessionHead} is the package-scoped retention entry
     * point; the arm drives the production geometry through it directly
     * rather than through a test-only API.
     */
    private static void lockSessionHead(JdbcTemplate jdbc, String tenant, String session) {
        try {
            var method = ToolPublicationRetentionStore.class.getDeclaredMethod(
                    "lockSessionHead", JdbcTemplate.class, String.class, String.class);
            method.setAccessible(true);
            method.invoke(null, jdbc, tenant, session);
        } catch (InvocationTargetException error) {
            if (error.getCause() instanceof RuntimeException runtime) {
                throw runtime;
            }
            throw new AssertionError(error.getCause());
        } catch (ReflectiveOperationException error) {
            throw new AssertionError(error);
        }
    }

    /** Runs the subject while a placement holder holds the tenant guard by name, then releases it.
     *  Ordinary authorization no longer acquires tenant-wide rows after #13800, so the
     *  placement owner is the placement acquisition itself — the contention point is the
     *  row, not the API. */
    private static JsonNode contend(OwnerPauseDataSource source, JdbcTemplate admin, String schema,
            PublicationJournalFixture journal, Callable<JsonNode> subject) throws Exception {
        var transaction = new TransactionTemplate(journal.manager);
        var owners = Executors.newSingleThreadExecutor(task -> new Thread(task, "owner"));
        var subjects = Executors.newSingleThreadExecutor(task -> new Thread(task, "subject"));
        try {
            source.enabled = true;
            var owner = owners.submit(() -> transaction.executeWithoutResult(status ->
                    WorkspaceLifecycleStore.lockPlacement(journal.jdbc, "tenant-1")));
            assertThat(source.ownerPlacement.await(10, TimeUnit.SECONDS)).isTrue();
            var result = subjects.submit(subject);
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
            int waiting;
            while ((waiting = MySqlLockProbe.lockWaits(admin, schema)) == 0 && !result.isDone()) {
                assertThat(System.nanoTime()).isLessThan(deadline);
                // InnoDB refreshes its transaction table only after 100 ms without a read.
                Thread.sleep(200);
            }
            if (waiting == 0 && result.isDone()) {
                result.get(30, TimeUnit.SECONDS);
            }
            assertThat(waiting).as("Publication waits for the placement owner").isPositive();
            assertThat(source.subjectPlacementLocks.get())
                    .as("Placement precedes retention in the contending transaction")
                    .containsExactly("placement");
            source.releaseOwner.countDown();
            owner.get(30, TimeUnit.SECONDS);
            return result.get(30, TimeUnit.SECONDS);
        } finally {
            source.releaseOwner.countDown();
            source.enabled = false;
            // Let both transactions end before the schema is dropped.
            owners.shutdown();
            subjects.shutdown();
            assertThat(owners.awaitTermination(60, TimeUnit.SECONDS)
                    && subjects.awaitTermination(60, TimeUnit.SECONDS)).isTrue();
        }
    }

    private static final class OwnerPauseDataSource extends DelegatingDataSource {
        private final CountDownLatch ownerPlacement = new CountDownLatch(1);
        private final CountDownLatch ownerFirstLock = new CountDownLatch(1);
        private final CountDownLatch releaseOwner = new CountDownLatch(1);
        private final AtomicBoolean paused = new AtomicBoolean();
        private final AtomicBoolean snapshotRead = new AtomicBoolean();
        private final AtomicReference<List<String>> subjectPlacementLocks = new AtomicReference<>();
        private volatile boolean enabled;
        private volatile boolean pauseOwnerOnFirstInsert;
        private volatile Runnable afterSnapshot;

        private OwnerPauseDataSource(DataSource source) {
            super(source);
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
            // Standalone preflight releases locks on other connections before contention.
            List<String> requestedLocks = new ArrayList<>();
            return (Connection) Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[] {Connection.class},
                    (proxy, method, args) -> {
                        try {
                            Object result = method.invoke(connection, args);
                            if (!method.getName().equals("prepareStatement") || !(result instanceof PreparedStatement statement)) {
                                return result;
                            }
                            String sql = (String) args[0];
                            return Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[] {PreparedStatement.class},
                                    (prepared, call, values) -> {
                                        try {
                                            if (enabled && call.getName().startsWith("execute")
                                                    && "subject".equals(Thread.currentThread().getName())) {
                                                if (sql.startsWith("INSERT INTO ma_session") && sql.contains("ON DUPLICATE KEY UPDATE")) {
                                                    requestedLocks.add("root");
                                                } else if (sql.startsWith("INSERT INTO ma_tenant_guard") && sql.contains("'runtime_placement'")) {
                                                    requestedLocks.add("placement");
                                                    subjectPlacementLocks.set(List.copyOf(requestedLocks));
                                                } else if (sql.startsWith("INSERT INTO ma_tenant_guard") && sql.contains("'output_publication'")) {
                                                    requestedLocks.add("retention");
                                                }
                                            }
                                            Object value = call.invoke(statement, values);
                                            if (afterSnapshot != null && call.getName().startsWith("execute")
                                                    && sql.contains(" FROM ma_output_capture WHERE scope_key = ?")
                                                    && !sql.contains("FOR UPDATE") && snapshotRead.compareAndSet(false, true)) {
                                                afterSnapshot.run();
                                            }
                                            if (enabled && call.getName().startsWith("execute")
                                                    && "owner".equals(Thread.currentThread().getName())
                                                    && sql.startsWith("SELECT tenant_id FROM ma_tenant_guard") && sql.contains("'runtime_placement'")
                                                    && paused.compareAndSet(false, true)) {
                                                ownerPlacement.countDown();
                                                if (!releaseOwner.await(30, TimeUnit.SECONDS)) {
                                                    throw new AssertionError("Owner hold timed out");
                                                }
                                            }
                                            if (enabled && pauseOwnerOnFirstInsert && call.getName().startsWith("execute")
                                                    && "owner".equals(Thread.currentThread().getName())
                                                    && sql.startsWith("INSERT INTO")
                                                    && paused.compareAndSet(false, true)) {
                                                ownerFirstLock.countDown();
                                                if (!releaseOwner.await(30, TimeUnit.SECONDS)) {
                                                    throw new AssertionError("Owner hold timed out");
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
}
