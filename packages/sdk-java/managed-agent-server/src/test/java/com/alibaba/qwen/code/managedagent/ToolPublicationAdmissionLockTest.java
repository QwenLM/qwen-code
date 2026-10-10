package com.alibaba.qwen.code.managedagent;

import static com.alibaba.qwen.code.managedagent.PublicationJournalFixture.WRITER_TOKEN;
import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationAdmissionStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationDataStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationObjectStore;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.InputStream;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.time.Duration;
import java.util.Base64;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.jdbc.datasource.AbstractDataSource;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;

@Timeout(30)
class ToolPublicationAdmissionLockTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    DataSource publicationDataSource() {
        return new DriverManagerDataSource("jdbc:h2:mem:receipt-parent-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE;LOCK_TIMEOUT=1000", "sa", "");
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void receiptDoesNotHoldTenantWhileWaitingForNativeParent(boolean replay) throws Exception {
        var gates = new ParentGates();
        DataSource source = gates.wrap(publicationDataSource());
        Flyway.configure().dataSource(source).load().migrate();
        var fixture = PublicationJournalFixture.create(source, false);
        fixture.reserve();
        var bucket = new ToolPublicationObjectStore() {
            @Override
            public void putIfAbsent(String key, byte[] bytes) { throw new AssertionError("Unexpected object write"); }
            @Override
            public InputStream open(String key) { throw new AssertionError("Unexpected object read"); }
            @Override
            public void requireUnversioned() { }
        };
        var data = new ToolPublicationDataStore(fixture.jdbc, fixture.manager, fixture.store, fixture.sessions,
                bucket, Duration.ofMinutes(2), Duration.ofSeconds(30),
                new ToolPublicationDataStore.VerificationBudget(16 * 1024 * 1024, Duration.ofMinutes(25)));
        var key = fixture.binding.path("sessionKey");
        var terminal = JSON.createObjectNode().put("executionStatus", "error");
        terminal.putArray("responseParts");
        terminal.set("capture", JSON.createObjectNode().put("captureStatus", "unavailable")
                .put("captureReason", "storage_failed").put("previewTruncated", false)
                .put("deliveryStatus", "pending").putNull("manifest"));
        data.finish(key, "pub-1", PublicationJournalFixture.PUBLICATION_TOKEN, "finish",
                terminal.toString().getBytes(StandardCharsets.UTF_8));
        var outcome = JSON.createObjectNode().put("schemaVersion", 1).put("decision", "blocked").putNull("manifestRef");
        outcome.set("envelope", terminal);
        var history = JSON.createObjectNode().put("messageId", UUID.randomUUID().toString())
                .put("timestamp", "2026-10-07T00:00:00Z").put("model", "test");
        history.putArray("parts");
        outcome.set("history", history);
        var admission = data.prepareAdmission(key, "pub-1", "writer-1", 1, WRITER_TOKEN, outcome);
        var payload = JSON.createObjectNode().put("executionCallId", "execution-1")
                .put("historyRevision", fixture.sequence + 1).putNull("resultRef");
        payload.set("toolOutcomeRef", admission);
        payload.putArray("resources");
        String records = fixture.event(fixture.sequence + 1, "tool.receipt", payload)
                + PublicationJournalFixture.COMMIT_MARKER;
        String digest = PublicationJournalFixture.digest(records);
        var receiptRequest = new ManagedSessionStoreModels.CommitTransactionRequest("workspace-1", "writer-1", 1,
                fixture.revision, fixture.sequence, "receipt", "recordToolResult", "execution-1",
                admission.path("digest").asText(), fixture.sequence + 1, fixture.sequence + 1, 1,
                digest, fixture.commitDigest, digest, 1, null, 2,
                Base64.getEncoder().encodeToString(records.getBytes(StandardCharsets.UTF_8)), digest,
                List.of(new ManagedSessionStoreModels.CommitResource(admission.path("resourceId").asText(),
                        "managed-tool-outcome", 1, admission.path("byteLength").asLong(),
                        admission.path("digest").asText(), null)));
        var admissions = new ToolPublicationAdmissionStore(fixture.jdbc, fixture.manager, fixture.sessions, data);
        if (replay) {
            admissions.commitReceipt(key, "pub-1", WRITER_TOKEN, receiptRequest);
        }
        var transaction = new TransactionTemplate(fixture.manager);
        transaction.executeWithoutResult(status -> fixture.sessions.acquireWriter("tenant-1", "session-2",
                WRITER_TOKEN, new ManagedSessionStoreModels.AcquireWriterRequest("workspace-1", "writer-1", 300000L)));
        String initial = "{}\n{}\n";
        String initialDigest = PublicationJournalFixture.digest(initial);
        var nativeRequest = new ManagedSessionStoreModels.CommitTransactionRequest("workspace-1", "writer-1", 1,
                0, 0, "native", "session.create", "create", initialDigest, 0, 0, 0,
                null, null, null, 0, null, 2,
                Base64.getEncoder().encodeToString(initial.getBytes(StandardCharsets.UTF_8)), initialDigest, List.of());
        try (var threads = Executors.newFixedThreadPool(3)) {
            var nativeCommit = threads.submit(() -> {
                gates.nativeWriter.set(Thread.currentThread());
                return transaction.execute(status -> fixture.sessions.commit("tenant-1", "session-2",
                        WRITER_TOKEN, nativeRequest));
            });
            try {
                assertThat(gates.nativeDomainHeld.await(10, TimeUnit.SECONDS)).isTrue();
                var receipt = threads.submit(() -> {
                    gates.receiptWriter.set(Thread.currentThread());
                    return admissions.commitReceipt(key, "pub-1", WRITER_TOKEN, receiptRequest);
                });
                assertThat(gates.receiptSeekingDomain.await(10, TimeUnit.SECONDS)).isTrue();
                // A receipt waiting for the shared parent must leave the retention tenant available.
                var tenantProbe = threads.submit(() -> transaction.execute(status ->
                        fixture.jdbc.queryForObject("SELECT tenant_id FROM qwen_tool_publication_tenant"
                                + " WHERE tenant_id = 'tenant-1' FOR UPDATE", String.class)));
                assertThat(tenantProbe.get(2, TimeUnit.SECONDS)).isEqualTo("tenant-1");
                if (receipt.isDone()) {
                    receipt.get(10, TimeUnit.SECONDS);
                }
                assertThat(receipt.isDone()).isFalse();
                gates.releaseNative.countDown();
                assertThat(nativeCommit.get(10, TimeUnit.SECONDS).journalRevision()).isEqualTo(1);
                assertThat(receipt.get(10, TimeUnit.SECONDS).path("decision").asText()).isEqualTo("blocked");
                assertThat(fixture.jdbc.queryForObject("SELECT producer_phase FROM qwen_tool_publication",
                        String.class)).isEqualTo("REFERENCED");
                assertThat(fixture.jdbc.queryForObject("SELECT COUNT(*) FROM qwen_managed_session_journal_tx"
                        + " WHERE operation = 'recordToolResult'", Integer.class)).isEqualTo(1);
            } finally {
                gates.releaseNative.countDown();
            }
        }
    }

    private static final class ParentGates {
        private final AtomicReference<Thread> nativeWriter = new AtomicReference<>();
        private final AtomicReference<Thread> receiptWriter = new AtomicReference<>();
        private final AtomicBoolean paused = new AtomicBoolean();
        private final CountDownLatch nativeDomainHeld = new CountDownLatch(1);
        private final CountDownLatch releaseNative = new CountDownLatch(1);
        private final CountDownLatch receiptSeekingDomain = new CountDownLatch(1);

        DataSource wrap(DataSource delegate) {
            return new AbstractDataSource() {
                @Override
                public Connection getConnection() throws SQLException { return observe(delegate.getConnection()); }
                @Override
                public Connection getConnection(String user, String password) throws SQLException {
                    return observe(delegate.getConnection(user, password));
                }
            };
        }

        private Connection observe(Connection connection) {
            return (Connection) Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[]{Connection.class},
                    (proxy, method, arguments) -> {
                        Object value = invoke(connection, method, arguments);
                        if (!"prepareStatement".equals(method.getName())) {
                            return value;
                        }
                        String sql = (String) arguments[0];
                        return Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[]{PreparedStatement.class},
                                (statement, call, parameters) -> {
                                    if (Thread.currentThread() == receiptWriter.get() && call.getName().startsWith("execute")
                                            && sql.startsWith("INSERT INTO qwen_runtime_placement_guard")) {
                                        receiptSeekingDomain.countDown();
                                    }
                                    Object result = invoke(value, call, parameters);
                                    if (Thread.currentThread() == nativeWriter.get() && "executeQuery".equals(call.getName())
                                            && sql.startsWith("SELECT tenant_id FROM qwen_runtime_placement_guard")
                                            && paused.compareAndSet(false, true)) {
                                        nativeDomainHeld.countDown();
                                        if (!releaseNative.await(20, TimeUnit.SECONDS)) {
                                            throw new IllegalStateException("Native parent test gate was not released");
                                        }
                                    }
                                    return result;
                                });
                    });
        }

        private static Object invoke(Object target, Method method, Object[] arguments) throws Throwable {
            try {
                return method.invoke(target, arguments);
            } catch (InvocationTargetException error) {
                throw error.getCause();
            }
        }
    }
}
