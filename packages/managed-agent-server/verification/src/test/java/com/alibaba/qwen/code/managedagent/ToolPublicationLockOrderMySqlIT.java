package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.contracts.artifact.ToolPublicationObjectStore;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.CommitResource;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.CommitTransactionRequest;
import com.alibaba.qwen.code.managedagent.persistence.JdbcManagedToolResultStore;
import com.alibaba.qwen.code.managedagent.persistence.JdbcWorkspaceLifecycleStore;
import com.alibaba.qwen.code.managedagent.persistence.ToolPublicationAdmissionStore;
import com.alibaba.qwen.code.managedagent.persistence.ToolPublicationDataStore;
import com.alibaba.qwen.code.managedagent.persistence.ToolPublicationRetentionStore;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DelegatingDataSource;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.DefaultTransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.io.InputStream;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import static com.alibaba.qwen.code.managedagent.PublicationJournalFixture.COMMIT_MARKER;
import static com.alibaba.qwen.code.managedagent.PublicationJournalFixture.PUBLICATION_TOKEN;
import static com.alibaba.qwen.code.managedagent.PublicationJournalFixture.WRITER_TOKEN;
import static com.alibaba.qwen.code.managedagent.PublicationJournalFixture.digest;
import static com.alibaba.qwen.code.managedagent.persistence.PublicationVerification.verified;
import static org.assertj.core.api.Assertions.assertThat;

class ToolPublicationLockOrderMySqlIT {
    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void projectionCompletionSkipsTheTenantGuard() throws Exception {
        String url = System.getProperty("mysql.url");
        if (url == null || !url.matches("jdbc:mysql://[^/]+/[^?]+(?:\\?.*)?")) {
            throw new IllegalArgumentException("A MySQL test database URL is required");
        }
        String user = System.getProperty("mysql.user");
        String password = System.getProperty("mysql.password", "");
        var admin = new JdbcTemplate(new DriverManagerDataSource(url, user, password));
        String schema = "projection_guard_" + UUID.randomUUID().toString().replace("-", "");
        admin.execute("CREATE DATABASE " + schema);
        try {
            var source = new DriverManagerDataSource(
                    url.replaceFirst("/[^/?]+(?=\\?|$)", "/" + schema), user, password);
            var fixture = ToolPublicationStoreTest.apiFixture(source);
            var jdbc = fixture.jdbc();
            var artifacts = fixture.results().listArtifacts("tenant-1", "session-1", null, null, null, 100).artifacts();
            var descriptor = JSON.readTree(jdbc.queryForObject(
                    "SELECT result_json FROM ma_operation WHERE operation_kind = 'TOOL_RESULT_PROJECTION'", String.class));
            var projection = new JdbcManagedToolResultStore.Projection(descriptor, "pub-1",
                    artifacts.getFirst().binding(), artifacts.getFirst().manifestRef(), artifacts, fixture.policy().version());
            ToolPublicationStoreTest.releaseArtifacts(jdbc, fixture.manager());
            jdbc.update("DELETE FROM ma_public_event WHERE event_type = 'item.tool_result.updated'");
            jdbc.update("UPDATE ma_operation SET state = 'PENDING', available_at = 0"
                    + " WHERE operation_kind = 'TOOL_RESULT_PROJECTION'");
            var claim = fixture.results().claim().orElseThrow();
            jdbc.update("INSERT INTO ma_tenant_guard (tenant_id, guard_domain)"
                            + " VALUES (?, 'output_publication') ON DUPLICATE KEY UPDATE tenant_id = tenant_id",
                    "tenant-1");
            var pool = Executors.newSingleThreadExecutor();
            var hold = fixture.manager().getTransaction(new DefaultTransactionDefinition());
            try {
                assertThat(jdbc.queryForObject("SELECT tenant_id FROM ma_tenant_guard"
                                + " WHERE guard_domain = 'output_publication' AND tenant_id = ? FOR UPDATE",
                        String.class, "tenant-1"))
                        .isEqualTo("tenant-1");
                long before = System.nanoTime();
                assertThat(pool.submit(() -> fixture.results().complete(claim, projection, fixture.policy().version()))
                        .get(15, TimeUnit.SECONDS)).isTrue();
                assertThat((System.nanoTime() - before) / 1_000_000).isLessThan(15_000);
            } finally {
                fixture.manager().rollback(hold);
                pool.shutdownNow();
                assertThat(pool.awaitTermination(10, TimeUnit.SECONDS)).isTrue();
            }
            assertThat(jdbc.queryForObject("SELECT state FROM ma_operation"
                            + " WHERE operation_kind = 'TOOL_RESULT_PROJECTION'", String.class))
                    .isEqualTo("READY");
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_public_event"
                            + " WHERE event_type = 'item.tool_result.updated'", Integer.class))
                    .isEqualTo(1);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_artifact", Integer.class))
                    .isEqualTo(artifacts.size());
        } finally {
            admin.execute("DROP DATABASE " + schema);
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"reserve", "renew"})
    void publicationSeesJournalCommittedAfterPlacementDiscovery(String operation) throws Exception {
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
            var journal = PublicationJournalFixture.create(source);
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
     * A placement owner pauses after the tenant placement guard. An ordinary publication path takes the
     * Session root instead and never requests placement, so it completes while the owner holds it; a
     * placement request after its root would close a cycle with every owner that locks this root behind
     * placement (design 2026-11-04-managed-publication-placement). Standalone admission and renew are the
     * shapes the HTTP controller uses.
     */
    @ParameterizedTest
    @ValueSource(strings = {"receipt", "admission-and-receipt", "admission", "renew", "ambient-renew"})
    void ordinaryPublicationDoesNotWaitForAPlacementOwner(String operation) throws Exception {
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
            var journal = PublicationJournalFixture.create(source);
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
                public InputStream openRange(String key, long offset, long length, Runnable guard) {
                    guard.run();
                    try (InputStream full = open(key)) {
                        byte[] bytes = full.readAllBytes();
                        return new java.io.ByteArrayInputStream(bytes, (int) offset, (int) length);
                    } catch (java.io.IOException error) {
                        throw new IllegalStateException(error);
                    }
                }
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
            verified(data).finish(key, "pub-1", PUBLICATION_TOKEN, "finish", envelope.toString().getBytes(StandardCharsets.UTF_8));
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
     * On an ordinary Session every lane that holds the tenant CAS row
     * reaches the Session root only after it, and the ordinary apply lane
     * (reserve, renew) no longer takes the CAS row at all: a renew takes
     * placement → root → head, including the read lease it takes for its
     * evidence, and the retention lane takes CAS → root. Taking the CAS row
     * after the root on either side (an earlier answer to #13800 R1-1, or a
     * read lease that relocks the CAS row) closes a cycle. Here the renew
     * completes while the retention owner holds the CAS row, and neither
     * side deadlocks.
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
            var journal = PublicationJournalFixture.create(source);
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
                JsonNode renewed = subject.get(30, TimeUnit.SECONDS);
                assertThat(renewed.path("state").asText()).isEqualTo(reserved.path("state").asText());
                assertThat(owner.isDone()).as("The retention owner still holds the CAS row").isFalse();
                source.releaseOwner.countDown();
                owner.get(30, TimeUnit.SECONDS);
                assertThat(MySqlLockProbe.innodbDeadlocks(admin) - deadlocksBefore)
                        .as("The renew never takes the CAS row after the root").isZero();
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
     *  The subject must complete while the row is held, without requesting placement. */
    private static JsonNode contend(OwnerPauseDataSource source, JdbcTemplate admin, String schema,
            PublicationJournalFixture journal, Callable<JsonNode> subject) throws Exception {
        var transaction = new TransactionTemplate(journal.manager);
        var owners = Executors.newSingleThreadExecutor(task -> new Thread(task, "owner"));
        var subjects = Executors.newSingleThreadExecutor(task -> new Thread(task, "subject"));
        try {
            source.enabled = true;
            var owner = owners.submit(() -> transaction.executeWithoutResult(status ->
                    JdbcWorkspaceLifecycleStore.lockPlacement(journal.jdbc, "tenant-1")));
            assertThat(source.ownerPlacement.await(10, TimeUnit.SECONDS)).isTrue();
            var result = subjects.submit(subject);
            JsonNode value;
            try {
                value = result.get(10, TimeUnit.SECONDS);
            } catch (java.util.concurrent.TimeoutException waiting) {
                throw new AssertionError("Ordinary publication waited for the placement owner; "
                        + MySqlLockProbe.describeLockWaits(admin, schema), waiting);
            }
            assertThat(source.subjectPlacementLocks.get()).as("An ordinary lane never requests placement").isNull();
            source.releaseOwner.countDown();
            owner.get(30, TimeUnit.SECONDS);
            return value;
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
                                                    && sql.contains(" FROM ma_output_capture WHERE scope_ref = ?")
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
