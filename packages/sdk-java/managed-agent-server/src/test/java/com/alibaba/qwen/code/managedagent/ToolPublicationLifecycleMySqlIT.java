package com.alibaba.qwen.code.managedagent;

import static com.alibaba.qwen.code.managedagent.PublicationJournalFixture.COMMIT_MARKER;
import static com.alibaba.qwen.code.managedagent.PublicationJournalFixture.PUBLICATION_TOKEN;
import static com.alibaba.qwen.code.managedagent.PublicationJournalFixture.WRITER_TOKEN;
import static com.alibaba.qwen.code.managedagent.PublicationJournalFixture.digest;
import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.CommitResource;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.CommitTransactionRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationAdmissionStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationDataStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationObjectStore;
import com.alibaba.qwen.code.managedagent.store.WorkspaceLifecycleStore;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.InputStream;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.time.Clock;
import java.time.Duration;
import java.util.Base64;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.support.DefaultListableBeanFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DelegatingDataSource;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;

class ToolPublicationLifecycleMySqlIT {
    private static final ObjectMapper JSON = new ObjectMapper();

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void receiptAndReplayDoNotDeadlockWithSameTenantLifecycleCompletion(boolean replay) throws Exception {
        String url = System.getProperty("mysql.url");
        if (url == null || !url.matches("jdbc:mysql://[^/]+/[^?]+(?:\\?.*)?")) {
            throw new IllegalArgumentException("A MySQL test database URL is required");
        }
        String user = System.getProperty("mysql.user");
        String password = System.getProperty("mysql.password", "");
        var admin = new JdbcTemplate(new DriverManagerDataSource(url, user, password));
        String schema = "publication_lifecycle_" + UUID.randomUUID().toString().replace("-", "");
        admin.execute("CREATE DATABASE " + schema);
        try {
            var source = new ScheduledDataSource(new DriverManagerDataSource(
                    url.replaceFirst("/[^/?]+(?=\\?|$)", "/" + schema), user, password));
            Flyway.configure().dataSource(source).load().migrate();
            var journal = PublicationJournalFixture.create(source, false);
            journal.reserve();
            var jdbc = journal.jdbc;
            var transaction = new TransactionTemplate(new DataSourceTransactionManager(source));
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
                    .put("timestamp", "2026-10-06T00:00:00Z").put("model", "test");
            history.putArray("parts").addObject().put("text", "Shell capture unavailable");
            outcome.set("history", history);
            var root = data.prepareAdmission(key, "pub-1", "writer-1", 1, WRITER_TOKEN, outcome);
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
            if (replay) {
                admission.commitReceipt(key, "pub-1", WRITER_TOKEN, request);
            }

            var properties = new ManagedAgentProperties();
            properties.getHarness().setWorkspaceFilesEnabled(true);
            var agents = new ManagedAgentStore(jdbc, JSON, Clock.systemUTC(), ignored -> {},
                    new ManagedWorkspaceRegistry(jdbc), properties);
            var beans = new DefaultListableBeanFactory();
            beans.registerSingleton("bindings", journal.bindings);
            var lifecycle = new WorkspaceLifecycleStore(jdbc, JSON, beans.getBeanProvider(RuntimeBindingRepository.class));
            agents.setWorkspaceLifecycleStore(lifecycle);
            jdbc.update("INSERT INTO managed_workspace_registry (tenant_id, workspace_id, workspace_generation,"
                    + " storage_id, display_name, config_ref, policy_ref, state)"
                    + " VALUES ('tenant-1', 'neighbor', 1, 'storage', 'Neighbor', ?, ?, 'ACTIVE')",
                    WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
            jdbc.update("INSERT INTO managed_workspace_access (tenant_id, workspace_id, actor_id, can_read, can_create)"
                    + " VALUES ('tenant-1', 'neighbor', ?, TRUE, TRUE)", "owner".getBytes(StandardCharsets.UTF_8));
            String session = transaction.execute(ignored -> agents.insertWorkspaceSessionCommand("tenant-1", "owner",
                    "create", "digest", "qwen-code", null, null, List.of(), null,
                    new WorkspaceSelection("neighbor", ".")).sessionId());
            String operationId = transaction.execute(ignored -> agents.beginWorkspaceLifecycle("tenant-1", session,
                    OperationKind.CLOSE, "owner", "a".repeat(64), "close", "digest", true, 1).operation().operationId());
            var operation = transaction.execute(ignored -> agents.claimOperation("tenant-1", session, operationId,
                    "worker", Duration.ofMinutes(5)).orElseThrow());
            assertThat(transaction.execute(ignored -> lifecycle.recoverEffects(operation)).path("neverInitialized").asBoolean()).isTrue();
            source.enabled = true;
            try (var workers = Executors.newFixedThreadPool(2)) {
                var completion = workers.submit(() -> {
                    Thread.currentThread().setName("lifecycle");
                    return transaction.execute(ignored -> agents.completeOperation("tenant-1", session, operationId,
                            "worker", operation.claimGeneration(), true));
                });
                try {
                    assertThat(source.lifecyclePlacement.await(10, TimeUnit.SECONDS)).isTrue();
                    var receipt = workers.submit(() -> {
                        Thread.currentThread().setName("receipt");
                        return admission.commitReceipt(key, "pub-1", WRITER_TOKEN, request);
                    });
                    assertThat(source.receiptPlacement.await(10, TimeUnit.SECONDS)).isTrue();
                    source.releaseLifecycle.countDown();
                    assertThat(completion.get(10, TimeUnit.SECONDS)).isTrue();
                    assertThat(receipt.get(10, TimeUnit.SECONDS).path("historyRevision").asLong()).isEqualTo(sequence);
                } finally {
                    source.releaseLifecycle.countDown();
                }
            }
            source.enabled = false;
            assertThat(agents.requireSession("tenant-1", session).status()).isEqualTo("CLOSED");
            assertThat(agents.findOperation("tenant-1", session, operationId).orElseThrow().deliveryState()).isEqualTo("CONFIRMED");
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_managed_session_journal_tx"
                    + " WHERE tenant_id = 'tenant-1' AND session_id = 'session-1' AND operation = 'recordToolResult'", Integer.class)).isOne();
            assertThat(admission.commitReceipt(key, "pub-1", WRITER_TOKEN, request).path("historyRevision").asLong()).isEqualTo(sequence);
        } finally {
            admin.execute("DROP DATABASE " + schema);
        }
    }

    private static final class ScheduledDataSource extends DelegatingDataSource {
        private final CountDownLatch lifecyclePlacement = new CountDownLatch(1);
        private final CountDownLatch receiptPlacement = new CountDownLatch(1);
        private final CountDownLatch releaseLifecycle = new CountDownLatch(1);
        private final AtomicBoolean paused = new AtomicBoolean();
        private volatile boolean enabled;

        private ScheduledDataSource(DataSource source) {
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
                                        boolean execute = enabled && call.getName().startsWith("execute");
                                        String role = Thread.currentThread().getName();
                                        if (execute && "receipt".equals(role) && sql.startsWith("INSERT INTO qwen_runtime_placement_guard")) {
                                            receiptPlacement.countDown();
                                        }
                                        try {
                                            Object value = call.invoke(statement, values);
                                            if (execute && "lifecycle".equals(role)
                                                    && sql.startsWith("SELECT tenant_id FROM qwen_runtime_placement_guard")
                                                    && paused.compareAndSet(false, true)) {
                                                lifecyclePlacement.countDown();
                                                if (!releaseLifecycle.await(10, TimeUnit.SECONDS)) {
                                                    throw new AssertionError("Lifecycle hold timed out");
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
