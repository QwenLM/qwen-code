package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.runtimebroker.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DelegatingDataSource;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ManagedSessionNativeReadTest {
    private static final String TOKEN = "csi-original-writer-token-for-test";
    private static final byte[] BYTES = "original resource".getBytes(StandardCharsets.UTF_8);
    private FaultSource source;
    private JdbcTemplate jdbc;
    private TransactionTemplate transactions;
    private ManagedSessionStore store;
    private String session;
    private RuntimeBindingRecord binding;
    private JdbcRuntimeBindingRepository bindings;
    private WorkspaceCsiReservationStore reservations;
    private WorkspaceCsiReservationStore.Reservation reservation;
    private WorkspaceCsiRegistration registration;

    @BeforeEach
    void setUp() {
        var raw = new DriverManagerDataSource("jdbc:h2:mem:native-read-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "");
        Flyway.configure().dataSource(raw).locations("classpath:db/managed-schema").load().migrate();
        source = new FaultSource(raw);
        jdbc = new com.alibaba.qwen.code.managedagent.store.ManagedSchemaJdbcTemplate(source);
        var manager = new DataSourceTransactionManager(source);
        transactions = new TransactionTemplate(manager);
        reservations = new WorkspaceCsiReservationStore(jdbc, manager, new ObjectMapper());
        registration = new WorkspaceCsiRegistration("tenant", "storage", "cluster", "ns", "pvc", "pvc-uid",
                "pv", "pv-uid", "disk.csi.example.com", "volume", "backend", "disk-serial", "/workspace", 7);
        reservations.register(registration);
        var request = WorkspaceCsiRuntimeConstructionFixture.create(source, registration);
        session = request.getIsolationKey();
        bindings = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("test", new byte[32]));
        binding = bindings.findOrCreate(request);
        binding = bindings.claimOperation(binding.getBindingId(), "operator", Duration.ofSeconds(120));
        reservation = reservations.reserve(registration, bindings, binding, UUID.randomUUID().toString());
        var seed = binding.getProvisionSeed();
        var lease = new RuntimeLease(seed.getProvisionalRuntimeId(), URI.create("https://original.example.invalid"),
                seed.getToken(), seed.getLeaseId(), seed.getEpoch());
        binding = bindings.compareAndSet(binding, binding.withAttestation(lease,
                new RuntimeResourceHandle("kubernetes-workspace", 3, Map.of("podUid", "fixture-original")),
                Instant.now(), Instant.now()));
        store = new ManagedSessionStore(jdbc);
        transactions.execute(status -> store.acquireWriter("tenant", session, TOKEN,
                new ManagedSessionStoreModels.AcquireWriterRequest("workspace", "writer", 300_000L)));
        jdbc.update(
                "INSERT INTO ma_resource (resource_key, session_scope_key, tenant_id, workspace_id, session_id, resource_id, kind, schema_version, byte_length, sha256, storage_kind, inline_bytes, publish_command_id, state, gmt_create, last_verified_at) VALUES (?, ?, 'tenant', 'workspace', ?, 'resource', 'managed-session-context', 1, ?, ?, 'MYSQL_INLINE', ?, 'fixture', 'REFERENCED', " + ManagedSchemaTime.SQL_NOW + ", 946684800000)",
                ManagedSessionStore.resourceKey(
                        ManagedSessionStore.sessionScopeKey("tenant", session), "resource"),
                ManagedSessionStore.sessionScopeKey("tenant", session), session, BYTES.length,
                ToolPublicationContract.sha256(BYTES), BYTES);
    }

    @AfterEach
    void closeOwnedDatabase() {
        source.onFetch = () -> {};
        source.closeFailure = "";
        jdbc.execute("SHUTDOWN");
    }

    @Test
    void readsBeforeActivationAndRetainsDistinctOriginalHistory() {
        assertThat(read().bytes()).isEqualTo(BYTES);
        assertThat(read().bytes()).isEqualTo(BYTES);
        var history = readReceipts();
        assertThat(history).hasSize(2);
        assertThat(history).allSatisfy(row -> {
            assertThat(row.get("state")).isEqualTo("RETURNED");
            assertThat(row.get("outcome_code")).isEqualTo("verified");
            assertThat(row.get("activation_id")).isNull();
            assertThat(row.get("binding_id")).isEqualTo(binding.getBindingId());
            assertThat(row.get("session_id")).isEqualTo(session);
            assertThat(row.get("writer_token_hash")).isEqualTo(ToolPublicationContract.sha256(TOKEN.getBytes(StandardCharsets.UTF_8)));
            assertThat(row.get("ended_at")).isNotNull();
        });
        assertThat(count("ma_read_lease")).isZero();
        assertThat(history.getFirst().get("read_id")).isNotEqualTo(history.getLast().get("read_id"));
    }

    @Test
    void sealingRefusesNonCheckpointReadsBeforeHistoryOrFetch() {
        retire();
        source.onFetch = () -> { throw new AssertionError("sealed read reached fetch"); };
        assertThatThrownBy(this::read).isInstanceOfSatisfying(RuntimeBrokerException.class,
                error -> assertThat(error.getCode()).isEqualTo("runtime_admission_closed"));
        assertThat(count("ma_request_receipt")).isZero();
        assertThat(count("ma_read_lease")).isZero();
    }

    @Test
    void admittedFetchRunsOutsideSqlAndRetainsEvidenceAfterOriginalSeal() {
        source.onFetch = () -> {
            assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
            assertThat(readReceipts().getFirst().get("state")).isEqualTo("OPEN");
            assertThat(count("ma_read_lease")).isEqualTo(1);
            retire();
        };
        assertThatThrownBy(this::read).isInstanceOf(RuntimeBrokerException.class);
        assertThat(readReceipts().getFirst().get("state")).isEqualTo("OPEN");
        assertThat(count("ma_read_lease")).isEqualTo(1);
        assertThat(reservations.inspect(registration).phase()).isEqualTo("DRAINING");
    }

    @ParameterizedTest
    @ValueSource(strings = {"result", "statement", "connection"})
    void physicalJdbcCleanupFailureKeepsUnknownAndRetryCannotEraseIt(String fault) {
        source.closeFailure = fault;
        assertThatThrownBy(this::read).isInstanceOf(DataAccessResourceFailureException.class)
                .hasRootCauseMessage("owned " + fault + " close failure");
        var old = readReceipts().getFirst();
        assertThat(old.get("state")).isEqualTo("UNKNOWN");
        assertThat(old.get("ended_at")).isNull();
        assertThat(count("ma_read_lease")).isEqualTo(1);
        assertThat(verifiedAt()).isEqualTo(java.time.Instant.parse("2000-01-01T00:00:00Z").toEpochMilli());
        source.closeFailure = "";
        assertThat(read().bytes()).isEqualTo(BYTES);
        assertThat(
                        readReceipts().stream()
                                .filter(row -> old.get("read_id").equals(row.get("read_id")))
                                .findFirst()
                                .orElseThrow())
                .isEqualTo(old);
        assertThat(count("ma_request_receipt")).isEqualTo(2);
        assertThat(count("ma_read_lease")).isEqualTo(1);
    }

    @Test
    void expiredDeliveryRecordsReturnedFailureWithoutVerifyingOrReturningBytes() {
        source.onFetch = () -> jdbc.update("UPDATE ma_read_lease SET expires_at = 0");
        assertCode(this::read, "tool_output_read_expired");
        assertThat(readReceipts().getFirst().get("state")).isEqualTo("RETURNED");
        assertThat((String) readReceipts().getFirst().get("outcome_code"))
                .isEqualTo("tool_output_read_expired");
        assertThat(count("ma_read_lease")).isZero();
        assertThat(verifiedAt()).isEqualTo(java.time.Instant.parse("2000-01-01T00:00:00Z").toEpochMilli());
    }

    @Test
    void writerTakeoverRecordsOldEndWithoutDeliveringOldBytes() {
        source.onFetch = () -> jdbc.update(
                                "UPDATE ma_session_head SET writer_generation = 2, writer_id ="
                                        + " 'successor'");
        assertThatThrownBy(this::read).isInstanceOf(ApiException.class);
        assertThat(readReceipts().getFirst().get("state")).isEqualTo("RETURNED");
        assertThat(verifiedAt()).isEqualTo(java.time.Instant.parse("2000-01-01T00:00:00Z").toEpochMilli());
    }

    @Test
    void corruptReturnedBytesKeepKnownEndButNeverUpdateVerification() {
        source.onFetch = () -> jdbc.update("UPDATE ma_resource SET inline_bytes = ?", new byte[] {0});
        assertThatThrownBy(this::read).isInstanceOf(ApiException.class);
        assertThat(readReceipts().getFirst().get("state")).isEqualTo("RETURNED");
        assertThat(verifiedAt()).isEqualTo(java.time.Instant.parse("2000-01-01T00:00:00Z").toEpochMilli());
    }

    @Test
    void completionIdentityFailurePreservesOpenAndOriginalFetchError() {
        source.onFetch = () -> {
            tamperReadWriter();
            throw new IllegalArgumentException("owned fetch failure");
        };
        assertThatThrownBy(this::read).isInstanceOf(IllegalArgumentException.class)
                .hasMessage("owned fetch failure").satisfies(error -> assertThat(error.getSuppressed()).hasSize(1));
        assertThat(readReceipts().getFirst().get("state")).isEqualTo("OPEN");
        assertThat(count("ma_read_lease")).isEqualTo(1);
        assertThat(verifiedAt()).isEqualTo(java.time.Instant.parse("2000-01-01T00:00:00Z").toEpochMilli());
    }

    @Test
    void ownerBoundaryRefusesAmbientTransactionAndObjectStorage() {
        assertThatThrownBy(() -> transactions.execute(status -> read())).isInstanceOf(IllegalStateException.class);
        jdbc.update(
                "UPDATE ma_resource SET storage_kind = 'TOOL_PUBLICATION', object_key ="
                        + " 'historical'");
        assertCode(this::read, "csi_inline_resource_required");
        assertThat(count("ma_request_receipt")).isZero();
        assertThat(count("ma_read_lease")).isZero();
    }

    @Test
    void invalidCredentialAndWrongWorkspaceRefuseBeforeAdmission() {
        assertThatThrownBy(() -> store.readOwnerResource("tenant", "workspace", session, "resource", "x".repeat(32)))
                .isInstanceOf(ApiException.class);
        assertThatThrownBy(() -> store.readOwnerResource("tenant", "other-workspace", session, "resource", TOKEN))
                .isInstanceOf(ApiException.class);
        assertThat(count("ma_request_receipt")).isZero();
        assertThat(count("ma_read_lease")).isZero();
    }

    @Test
    void ordinaryJournalOnlyOwnerKeepsGenericReaderWithoutNativeHistory() {
        String ordinary = "ordinary-session";
        transactions.execute(status -> store.acquireWriter("tenant", ordinary, TOKEN,
                new ManagedSessionStoreModels.AcquireWriterRequest("workspace", "ordinary-writer", 60_000L)));
        jdbc.update(
                "INSERT INTO ma_resource (resource_key, session_scope_key, tenant_id, workspace_id, session_id, resource_id, kind, schema_version, byte_length, sha256, storage_kind, inline_bytes, publish_command_id, state, gmt_create) VALUES (?, ?, 'tenant', 'workspace', ?, 'ordinary-resource', 'managed-session-context', 1, ?, ?, 'MYSQL_INLINE', ?, 'ordinary-fixture', 'REFERENCED', " + ManagedSchemaTime.SQL_NOW + ")",
                ManagedSessionStore.resourceKey(
                        ManagedSessionStore.sessionScopeKey("tenant", ordinary),
                        "ordinary-resource"),
                ManagedSessionStore.sessionScopeKey("tenant", ordinary), ordinary, BYTES.length,
                ToolPublicationContract.sha256(BYTES), BYTES);
        assertThat(store.readOwnerResource("tenant", "workspace", ordinary, "ordinary-resource", TOKEN).bytes())
                .isEqualTo(BYTES);
        assertThat(count("ma_request_receipt")).isZero();
        assertThat(count("ma_read_lease")).isZero();
    }

    private ManagedSessionStoreModels.StoredResource read() {
        return store.readOwnerResource("tenant", "workspace", session, "resource", TOKEN);
    }

    private java.util.List<java.util.Map<String, Object>> readReceipts() {
        return jdbc
                .queryForList(
                        "SELECT state, result_json FROM ma_request_receipt WHERE operation = 'CSI_RESOURCE_READ' ORDER BY gmt_create, receipt_key")
                .stream()
                .map(
                        row -> {
                            try {
                                var payload =
                                        new com.fasterxml.jackson.databind.ObjectMapper()
                                                .readTree((String) row.get("result_json"));
                                java.util.Map<String, Object> values =
                                        new java.util.LinkedHashMap<>();
                                payload.fields()
                                        .forEachRemaining(
                                                field -> {
                                                    var value = field.getValue();
                                                    Object decoded =
                                                            value.isNull()
                                                                    ? null
                                                                    : value.isNumber()
                                                                            ? value.longValue()
                                                                            : value.asText();
                                                    values.put(field.getKey(), decoded);
                                                });
                                values.put(
                                        "schema_version",
                                        payload.path("schema_version").intValue());
                                values.put("state", row.get("state"));
                                return values;
                            } catch (java.io.IOException error) {
                                throw new IllegalStateException(error);
                            }
                        })
                .toList();
    }

    private void tamperReadWriter() {
        String body =
                jdbc.queryForObject(
                        "SELECT result_json FROM ma_request_receipt WHERE operation ="
                                + " 'CSI_RESOURCE_READ'",
                        String.class);
        try {
            var changed =
                    (com.fasterxml.jackson.databind.node.ObjectNode)
                            new com.fasterxml.jackson.databind.ObjectMapper().readTree(body);
            changed.put("writer_id", "forged");
            jdbc.update(
                    "UPDATE ma_request_receipt SET result_json = ? WHERE operation ="
                            + " 'CSI_RESOURCE_READ'",
                    changed.toString());
        } catch (java.io.IOException error) {
            throw new IllegalStateException(error);
        }
    }

    private int count(String table) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM " + table
                        + ("ma_request_receipt".equals(table)
                                ? " WHERE operation = 'CSI_RESOURCE_READ'"
                                : ""), Integer.class);
    }

    private Long verifiedAt() {
        return jdbc.queryForObject(
                "SELECT last_verified_at FROM ma_resource", Long.class);
    }

    private void retire() {
        reservations.beginRetirement(registration, bindings, binding, reservation, UUID.randomUUID().toString());
    }

    private static void assertCode(Runnable action, String code) {
        assertThatThrownBy(action::run).isInstanceOfSatisfying(ApiException.class,
                error -> assertThat(error.getCode()).isEqualTo(code));
    }

    private static Object invoke(Object target, Method method, Object[] args) throws Throwable {
        try {
            return method.invoke(target, args);
        } catch (InvocationTargetException failure) {
            throw failure.getCause();
        }
    }

    private static final class FaultSource extends DelegatingDataSource {
        private Runnable onFetch = () -> {};
        private String closeFailure = "";

        private FaultSource(DriverManagerDataSource source) {
            super(source);
        }

        @Override
        public Connection getConnection() throws SQLException {
            Connection actual = super.getConnection();
            AtomicBoolean fetching = new AtomicBoolean();
            return (Connection) Proxy.newProxyInstance(Connection.class.getClassLoader(), new Class<?>[] {Connection.class},
                    (proxy, method, args) -> {
                        if ("equals".equals(method.getName())) {
                            return proxy == args[0];
                        }
                        if ("hashCode".equals(method.getName())) {
                            return System.identityHashCode(proxy);
                        }
                        Object result = invoke(actual, method, args);
                        if ("prepareStatement".equals(method.getName()) && args[0] instanceof String sql
                                && sql.startsWith("SELECT " + ManagedSchemaProjection.RESOURCE.columns() + " FROM ma_resource")
                                && !TransactionSynchronizationManager.isActualTransactionActive()) {
                            fetching.set(true);
                            return statement((PreparedStatement) result);
                        }
                        if ("close".equals(method.getName()) && fetching.get() && "connection".equals(closeFailure)) {
                            throw new SQLException("owned connection close failure");
                        }
                        return result;
                    });
        }

        private PreparedStatement statement(PreparedStatement actual) {
            return (PreparedStatement) Proxy.newProxyInstance(PreparedStatement.class.getClassLoader(),
                    new Class<?>[] {PreparedStatement.class}, (proxy, method, args) -> {
                        if ("executeQuery".equals(method.getName())) {
                            onFetch.run();
                            ResultSet rows = (ResultSet) invoke(actual, method, args);
                            return Proxy.newProxyInstance(ResultSet.class.getClassLoader(), new Class<?>[] {ResultSet.class},
                                    (rowProxy, rowMethod, rowArgs) -> {
                                        Object result = invoke(rows, rowMethod, rowArgs);
                                        if ("close".equals(rowMethod.getName()) && "result".equals(closeFailure)) {
                                            throw new SQLException("owned result close failure");
                                        }
                                        return result;
                                    });
                        }
                        Object result = invoke(actual, method, args);
                        if ("close".equals(method.getName()) && "statement".equals(closeFailure)) {
                            throw new SQLException("owned statement close failure");
                        }
                        return result;
                    });
        }
    }
}
