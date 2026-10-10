package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.store.ManagedRuntimeRetentionGuard;
import com.alibaba.qwen.code.managedagent.store.WorkspaceCsiRegistration;
import com.alibaba.qwen.code.managedagent.store.WorkspaceCsiReservationStore;
import com.alibaba.qwen.code.managedagent.store.WorkspaceExecutionStore;
import com.alibaba.qwen.code.managedagent.store.WorkspaceOperatorRecoveryStore;
import com.alibaba.qwen.code.runtimebroker.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeRetention;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.net.URI;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DelegatingDataSource;

class ManagedRuntimeRetentionRaceTest {
    private static final Instant OLD = Instant.parse("2000-01-01T00:00:00Z");
    private static final ObjectMapper JSON = new ObjectMapper();

    enum Reference {
        PUBLICATION("qwen_tool_publication"), HOLDER("managed_workspace_execution_lease"),
        OPERATOR("managed_workspace_operator_recovery"), CSI_RETIREMENT("managed_workspace_csi_retirement");
        final String table;
        Reference(String table) { this.table = table; }
    }

    @ParameterizedTest
    @EnumSource(Reference.class)
    void seesReferencesCommittedAfterTheSweepTransactionStarted(Reference reference) throws Exception {
        var fixture = new Fixture(dataSource(), reference);
        var started = new CountDownLatch(1);
        var committed = new CountDownLatch(1);
        var first = new AtomicBoolean(true);
        DataSource observed = new DelegatingDataSource(fixture.source) {
            @Override
            public Connection getConnection() throws SQLException {
                Connection connection = super.getConnection();
                return (Connection) Proxy.newProxyInstance(Connection.class.getClassLoader(),
                        new Class<?>[] {Connection.class}, (proxy, method, arguments) -> {
                            try {
                                Object result = method.invoke(connection, arguments);
                                if (method.getName().equals("setAutoCommit") && Boolean.FALSE.equals(arguments[0])
                                        && first.compareAndSet(true, false)) {
                                    assertThat(connection.getTransactionIsolation()).isEqualTo(Connection.TRANSACTION_READ_COMMITTED);
                                    // Establish a real table-read snapshot before the writer commits.
                                    try (var query = connection.prepareStatement("SELECT COUNT(*) FROM " + reference.table);
                                            var rows = query.executeQuery()) {
                                        assertThat(rows.next()).isTrue();
                                        assertThat(rows.getInt(1)).isZero();
                                    }
                                    started.countDown();
                                    await(committed);
                                }
                                return result;
                            } catch (InvocationTargetException error) {
                                throw error.getCause();
                            }
                        });
            }
        };
        try (var pool = Executors.newSingleThreadExecutor()) {
            var sweep = pool.submit(() -> retention(observed, new ManagedRuntimeRetentionGuard()).sweep(Duration.ofDays(30), 100, null));
            try {
                await(started);
                fixture.write.run();
                assertThat(fixture.count(reference.table)).isEqualTo(1);
                // New references are authorized only while live; retirement follows creation.
                fixture.retire();
            } finally {
                committed.countDown();
            }
            var result = sweep.get(5, TimeUnit.SECONDS);
            assertThat(result.bindingsScanned()).isEqualTo(1);
            assertThat(result.bindingsDeleted() + result.sessionsDeleted() + result.executionsDeleted()).isZero();
            assertThat(fixture.bindings.findById(fixture.binding.getBindingId())).isNotNull();
            assertThat(fixture.count(reference.table)).isEqualTo(1);
            if (reference == Reference.CSI_RETIREMENT) {
                // Retirement already pins the original family before any worker ACK can be created.
                assertThat(fixture.count("managed_workspace_csi_worker_ack")).isZero();
            }
        }
    }

    @ParameterizedTest
    @EnumSource(Reference.class)
    void writersCannotCreateDanglingReferencesAfterTheSweepLocksTheRetiredBinding(Reference reference) throws Exception {
        var fixture = new Fixture(dataSource(), reference);
        fixture.retire();
        fixture.jdbc.update("DELETE FROM managed_workspace_execution_lease");
        var locked = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        var first = new AtomicBoolean(true);
        var guard = new JdbcRuntimeRetention.ReferenceGuard() {
            private final ManagedRuntimeRetentionGuard delegate = new ManagedRuntimeRetentionGuard();
            public boolean bindingReferenced(Connection connection, RuntimeBindingRecord binding) throws SQLException {
                assertThat(connection.getTransactionIsolation()).isEqualTo(Connection.TRANSACTION_READ_COMMITTED);
                if (first.compareAndSet(true, false)) {
                    locked.countDown();
                    await(release);
                }
                return delegate.bindingReferenced(connection, binding);
            }
            public boolean executionReferenced(Connection connection, String call) throws SQLException {
                return delegate.executionReferenced(connection, call);
            }
        };
        try (var pool = Executors.newFixedThreadPool(2)) {
            var sweep = pool.submit(() -> retention(fixture.source, guard).sweep(Duration.ofDays(30), 100, null));
            var entered = new CountDownLatch(1);
            await(locked);
            var writer = pool.submit(() -> {
                entered.countDown();
                try {
                    fixture.write.run();
                    return null;
                } catch (RuntimeException failure) {
                    return failure;
                }
            });
            try {
                await(entered);
                assertThatThrownBy(() -> writer.get(150, TimeUnit.MILLISECONDS)).isInstanceOf(TimeoutException.class);
                assertThat(fixture.count(reference.table)).isZero();
            } finally {
                release.countDown();
            }
            assertThat(sweep.get(5, TimeUnit.SECONDS).bindingsDeleted()).isEqualTo(1);
            assertThat(writer.get(5, TimeUnit.SECONDS)).hasMessage(switch (reference) {
                case PUBLICATION -> "Original Runtime binding is missing";
                case HOLDER -> "Workspace execution authority is unavailable.";
                case OPERATOR -> "Exact Hosted Shell operator recovery is unavailable.";
                case CSI_RETIREMENT -> "Workspace CSI admission is unavailable.";
            });
            assertThat(fixture.bindings.findById(fixture.binding.getBindingId())).isNull();
            assertThat(fixture.count(reference.table)).isZero();
        } finally {
            release.countDown();
        }
    }

    DataSource dataSource() {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:retention-race-" + UUID.randomUUID()
                + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1;LOCK_TIMEOUT=10000");
        return source;
    }

    private static JdbcRuntimeRetention retention(DataSource source, JdbcRuntimeRetention.ReferenceGuard guard) {
        return new JdbcRuntimeRetention(source,
                new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("key", new byte[32])), guard);
    }

    private static void await(CountDownLatch latch) {
        try {
            assertThat(latch.await(5, TimeUnit.SECONDS)).isTrue();
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(error);
        }
    }

    private static final class Fixture {
        final DataSource source;
        final JdbcTemplate jdbc;
        final JdbcRuntimeBindingRepository bindings;
        final RuntimeBindingRecord binding;
        final Runnable write;
        final Reference reference;

        Fixture(DataSource source, Reference reference) {
            this.source = source;
            this.reference = reference;
            Flyway.configure().dataSource(source).load().migrate();
            jdbc = new JdbcTemplate(source);
            var manager = new DataSourceTransactionManager(source);
            if (reference == Reference.PUBLICATION || reference == Reference.CSI_RETIREMENT) {
                var registration = reference == Reference.CSI_RETIREMENT
                        ? new WorkspaceCsiRegistration("tenant-1", "storage", "cluster", "namespace", "claim", "pvc",
                                "volume", "pv", "driver", "handle", "backend", "serial", "/workspace", 1) : null;
                var publication = PublicationJournalFixture.create(source, false, registration);
                bindings = publication.bindings;
                binding = bindings.findById("binding-1");
                write = registration == null ? publication::reserve : () ->
                        new WorkspaceCsiReservationStore(jdbc, manager, JSON).beginRetirement(
                                registration, bindings, binding, publication.csiReservation, UUID.randomUUID().toString());
                return;
            }
            bindings = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("key", new byte[32]));
            var scope = new RuntimeScope("tenant", "workspace", "1", "/workspace", "sha256:" + "a".repeat(64), "session");
            var initial = bindings.findOrCreate(new RuntimeProvisionRequest(scope, "harness", "local-process", "storage"));
            var claim = bindings.claimOperation(initial.getBindingId(), "fixture", Duration.ofMinutes(1));
            var seed = claim.getProvisionSeed();
            binding = bindings.compareAndSet(claim, claim.withAttestation(new RuntimeLease(seed.getProvisionalRuntimeId(),
                    URI.create("http://127.0.0.1:9"), seed.getToken(), seed.getLeaseId(), seed.getEpoch()),
                    new RuntimeResourceHandle("local-process", 2, Map.of("fixture", "retention")), Instant.now(), Instant.now()));
            var sessions = new JdbcRuntimeSessionRepository(source);
            var session = bindings.admitSession(sessions, new RuntimeSessionRecord(
                    new RuntimeSession("harness", "session", "bootstrap", scope), binding.getBindingId(), binding.getGeneration(),
                    RuntimeSessionRecord.State.ACQUIRING, 0, Instant.now()));
            var context = new ContextBinding("tenant", "workspace", 1, "storage", ".", "context", 1);
            var holders = new WorkspaceExecutionStore(jdbc, manager);
            if (reference == Reference.HOLDER) {
                write = () -> holders.claim(context, session);
                return;
            }
            holders.claim(context, session);
            var executions = new JdbcToolExecutionRepository(source);
            var execution = executions.findOrCreate(ToolExecutionRecord.prepared("execution", "idempotency", binding.getBindingId(),
                    binding.getGeneration(), "harness", "session", "turn", "call", "digest", Map.of("toolName", "run_shell_command",
                            "sessionId", "session", "promptId", "turn", "callId", "call", "argsDigest", "digest")));
            var dispatch = executions.claimDispatch(execution.getExecutionCallId(), "dispatcher", Duration.ofMinutes(1));
            executions.compareAndSet(dispatch, dispatch.withResult(Map.of("executionStatus", "success",
                    "capture", Map.of("captureStatus", "partial", "captureReason", "producer_lost")), 1, Instant.now()),
                    "dispatcher", dispatch.getDispatchGeneration());
            var recovery = new WorkspaceOperatorRecoveryStore(jdbc, manager, bindings, JSON);
            String holder = recovery.inspect(binding.getBindingId(), binding.getGeneration()).holderKey();
            write = () -> recovery.prepare(binding.getBindingId(), binding.getGeneration(), holder, "operator", "incident");
        }

        void retire() {
            var executions = new JdbcToolExecutionRepository(source);
            for (var execution : executions.findByBinding(binding.getBindingId(), binding.getGeneration(), null, 100)) {
                if (!execution.isTerminal()) {
                    assertThat(executions.settlePrepared(execution, Map.of("executionStatus", "not_started"), OLD)).isNotNull();
                }
            }
            String receipt = binding.getRequest().isManagedContext() ? JSON.valueToTree(Map.of(
                    "version", 1, "bindingId", binding.getBindingId(), "generation", binding.getGeneration(),
                    "provisionRequestId", binding.getProvisionSeed().getProvisionRequestId(),
                    "handleKind", binding.getResourceHandle().getKind(), "handleVersion", binding.getResourceHandle().getVersion(),
                    "handle", JSON.valueToTree(binding.getResourceHandle().getValue()).toString(), "stoppedAt", OLD.toString())).toString() : null;
            // Age a completed lifecycle; production writers above still perform every reference admission check.
            jdbc.update("UPDATE qwen_runtime_binding SET binding_state = 'RELEASED', last_active_at = ?, drain_requested = TRUE,"
                    + " drain_receipt_json = ?, operation_owner = NULL, operation_lease_until = NULL", Timestamp.from(OLD), receipt);
            jdbc.update("UPDATE qwen_runtime_binding_slot SET active_binding_id = NULL");
            jdbc.update("UPDATE qwen_runtime_session SET session_state = 'RELEASED', last_active_at = ?", Timestamp.from(OLD));
            jdbc.update("UPDATE qwen_tool_execution SET settled_at = ?,"
                    + " dispatch_owner = NULL, dispatch_lease_until = NULL", Timestamp.from(OLD));
            if (reference == Reference.OPERATOR || reference == Reference.CSI_RETIREMENT) {
                jdbc.update("DELETE FROM managed_workspace_execution_lease");
            }
        }

        long count(String table) { return jdbc.queryForObject("SELECT COUNT(*) FROM " + table, Long.class); }
    }
}
