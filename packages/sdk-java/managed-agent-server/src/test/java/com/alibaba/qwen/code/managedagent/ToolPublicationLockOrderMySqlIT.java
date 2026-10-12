package com.alibaba.qwen.code.managedagent;

import static com.alibaba.qwen.code.managedagent.PublicationJournalFixture.COMMIT_MARKER;
import static com.alibaba.qwen.code.managedagent.PublicationJournalFixture.PUBLICATION_TOKEN;
import static com.alibaba.qwen.code.managedagent.PublicationJournalFixture.WRITER_TOKEN;
import static com.alibaba.qwen.code.managedagent.PublicationJournalFixture.digest;
import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.AuthorizeLifecycleRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.CommitResource;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.CommitTransactionRequest;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationAdmissionStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationDataStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationObjectStore;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
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
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DelegatingDataSource;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;

class ToolPublicationLockOrderMySqlIT {
    private static final ObjectMapper JSON = new ObjectMapper();

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
            Flyway.configure().dataSource(source).load().migrate();
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
                public void requireUnversioned() {}
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

    /** Runs the subject while a same-tenant ordinary authorization holds placement, then releases it. */
    private static JsonNode contend(OwnerPauseDataSource source, JdbcTemplate admin, String schema,
            PublicationJournalFixture journal, Callable<JsonNode> subject) throws Exception {
        var transaction = new TransactionTemplate(journal.manager);
        var owners = Executors.newSingleThreadExecutor(task -> new Thread(task, "owner"));
        var subjects = Executors.newSingleThreadExecutor(task -> new Thread(task, "subject"));
        try {
            source.enabled = true;
            var owner = owners.submit(() -> transaction.executeWithoutResult(status -> journal.sessions
                    .authorizeOrdinary("tenant-1", "session-1", WRITER_TOKEN,
                            new AuthorizeLifecycleRequest("workspace-1", "writer-1", 1))));
            assertThat(source.ownerPlacement.await(10, TimeUnit.SECONDS)).isTrue();
            var result = subjects.submit(subject);
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
            int waiting;
            while ((waiting = lockWaits(admin, schema)) == 0 && !result.isDone()) {
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

    private static int lockWaits(JdbcTemplate admin, String schema) {
        return admin.queryForObject("SELECT COUNT(*) FROM information_schema.innodb_trx t"
                + " JOIN information_schema.processlist p ON p.id = t.trx_mysql_thread_id"
                + " WHERE t.trx_state = 'LOCK WAIT' AND p.db = ?", Integer.class, schema);
    }

    private static final class OwnerPauseDataSource extends DelegatingDataSource {
        private final CountDownLatch ownerPlacement = new CountDownLatch(1);
        private final CountDownLatch releaseOwner = new CountDownLatch(1);
        private final AtomicBoolean paused = new AtomicBoolean();
        private final AtomicReference<List<String>> subjectPlacementLocks = new AtomicReference<>();
        private volatile boolean enabled;

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
                                                if (sql.startsWith("INSERT INTO qwen_runtime_placement_guard")) {
                                                    requestedLocks.add("placement");
                                                    subjectPlacementLocks.set(List.copyOf(requestedLocks));
                                                } else if (sql.startsWith("INSERT INTO qwen_tool_publication_tenant")) {
                                                    requestedLocks.add("retention");
                                                }
                                            }
                                            Object value = call.invoke(statement, values);
                                            if (enabled && call.getName().startsWith("execute")
                                                    && "owner".equals(Thread.currentThread().getName())
                                                    && sql.startsWith("SELECT tenant_id FROM qwen_runtime_placement_guard")
                                                    && paused.compareAndSet(false, true)) {
                                                ownerPlacement.countDown();
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
