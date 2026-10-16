package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;

import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.Map;
import java.util.UUID;

import javax.sql.DataSource;

class JdbcPhysicalStorageReleaseTest {
    @Test
    void aliasesReleaseOnlyTheirMatchingPhysicalHolder() throws Exception {
        var source = new JdbcDataSource();
        source.setURL(
                "jdbc:h2:mem:physical-release-"
                        + UUID.randomUUID()
                        + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1");
        verify(source);
    }

    static void verify(DataSource source) throws Exception {
        ManagedSchema.initialize(source);
        Fixture matched = new Fixture(source);
        matched.holder(matched.binding.getBindingId(), matched.binding.getGeneration());
        assertEquals(RuntimeSessionRecord.State.RELEASED, matched.release().getState());
        assertNull(matched.holder());
        assertEquals(
                2L,
                matched.scalar(
                        "SELECT COUNT(*) FROM ma_storage WHERE physical_key=?", matched.physical));

        Fixture frozen = new Fixture(source);
        frozen.execute(
                "UPDATE ma_storage_owner SET mount_state='FENCED' WHERE storage_key=?",
                frozen.physical);
        assertEquals(
                "workspace_migrating",
                assertThrows(
                                RuntimeBrokerException.class,
                                () -> frozen.bindings.findOrCreate(frozen.binding.getRequest()))
                        .getCode());
        assertEquals(
                "workspace_migrating",
                assertThrows(
                                RuntimeBrokerException.class,
                                () ->
                                        frozen.bindings.admitSession(
                                                frozen.sessions,
                                                new RuntimeSessionRecord(
                                                        new RuntimeSession(
                                                                "harness",
                                                                "late",
                                                                "bootstrap",
                                                                frozen.binding
                                                                        .getRequest()
                                                                        .getScope()),
                                                        frozen.binding.getBindingId(),
                                                        frozen.binding.getGeneration(),
                                                        RuntimeSessionRecord.State.ACQUIRING,
                                                        0,
                                                        Instant.now())))
                        .getCode());
        assertEquals(
                JdbcRuntimeBindingRepository.storageAliasKey(frozen.tenant, "second"),
                frozen.text(
                        "SELECT storage_alias_key FROM ma_runtime_binding WHERE binding_id=?",
                        frozen.binding.getBindingId().getBytes(StandardCharsets.UTF_8)));

        Fixture successor = new Fixture(source);
        successor.holder(successor.binding.getBindingId(), successor.binding.getGeneration() + 1);
        String original = successor.holder();
        assertEquals(
                "workspace_close_identity_unverified",
                assertThrows(RuntimeBrokerException.class, successor::release).getCode());
        assertEquals(original, successor.holder());
        successor.unreleased();

        Fixture missing = new Fixture(source);
        missing.execute("DELETE FROM ma_storage_owner WHERE storage_key=?", missing.physical);
        assertThrows(RuntimeBrokerException.class, missing::release);
        missing.unreleased();

        Fixture wrongScope = new Fixture(source);
        wrongScope.holder(wrongScope.binding.getBindingId(), wrongScope.binding.getGeneration());
        wrongScope.execute(
                "UPDATE ma_storage SET tenant_id=? WHERE alias_key=?",
                "other-tenant".getBytes(StandardCharsets.UTF_8),
                JdbcRuntimeBindingRepository.storageAliasKey(wrongScope.tenant, "second"));
        assertThrows(RuntimeBrokerException.class, wrongScope::release);
        assertNotNull(wrongScope.holder());
        wrongScope.unreleased();
    }

    private static final class Fixture {
        private final DataSource source;
        private final String tenant = "release-" + UUID.randomUUID();
        private final String physical = ManagedSchemaKeys.key("local-volume", tenant);
        private final JdbcRuntimeBindingRepository bindings;
        private final JdbcRuntimeSessionRepository sessions;
        private final JdbcToolExecutionRepository executions;
        private final RuntimeBindingRecord binding;
        private final RuntimeSessionRecord session;

        Fixture(DataSource source) throws Exception {
            this.source = source;
            bindings =
                    new JdbcRuntimeBindingRepository(
                            source, new AesGcmSecretProtector("release", new byte[32]));
            sessions = new JdbcRuntimeSessionRepository(source);
            executions = new JdbcToolExecutionRepository(source);
            alias(tenant + "-first", "first");
            alias(tenant, "second");
            execute(
                    "INSERT INTO"
                        + " ma_storage_owner(storage_key,physical_key,storage_kind,tenant_id,storage_id,mount_state)"
                        + " VALUES(?,?,'LOCAL',?,?,'READY')",
                    physical,
                    physical,
                    (tenant + "-first").getBytes(StandardCharsets.UTF_8),
                    "first".getBytes(StandardCharsets.UTF_8));
            var scope =
                    new RuntimeScope(
                            tenant,
                            "workspace",
                            "1",
                            "/workspace",
                            WorkspaceExecutionProfile.CAPABILITY_DIGEST,
                            "session");
            var initial =
                    bindings.findOrCreate(
                            new RuntimeProvisionRequest(
                                    scope, "harness", "local-process", "second"));
            var claim =
                    bindings.claimOperation(initial.getBindingId(), "setup", Duration.ofMinutes(1));
            var seed = claim.getProvisionSeed();
            var lease =
                    new RuntimeLease(
                            seed.getProvisionalRuntimeId(),
                            URI.create("http://127.0.0.1:9999"),
                            seed.getToken(),
                            seed.getLeaseId(),
                            seed.getEpoch());
            var ready =
                    bindings.compareAndSet(
                            claim,
                            claim.withAttestation(
                                    lease,
                                    new RuntimeResourceHandle(
                                            "local-process",
                                            2,
                                            Map.of("resource", initial.getBindingId())),
                                    Instant.now(),
                                    Instant.now()));
            ready =
                    bindings.releaseOperation(
                            ready.getBindingId(), "setup", ready.getOperationGeneration());
            var acquired =
                    bindings.admitSession(
                            sessions,
                            new RuntimeSessionRecord(
                                    new RuntimeSession("harness", "original", "bootstrap", scope),
                                    ready.getBindingId(),
                                    ready.getGeneration(),
                                    RuntimeSessionRecord.State.ACQUIRING,
                                    0,
                                    Instant.now()));
            var active =
                    sessions.compareAndSet(
                            acquired,
                            acquired.withState(RuntimeSessionRecord.State.READY, Instant.now()));
            session =
                    sessions.compareAndSet(
                            active,
                            active.withState(RuntimeSessionRecord.State.RELEASING, Instant.now()));
            claim = bindings.claimOperation(ready.getBindingId(), "stop", Duration.ofMinutes(1));
            var draining =
                    bindings.compareAndSet(
                            claim,
                            claim.withDrainRequested(true, Instant.now())
                                    .withState(
                                            RuntimeBindingRecord.State.DRAINING,
                                            claim.getLease(),
                                            Instant.now()));
            binding =
                    bindings.compareAndSet(
                            draining,
                            draining.withDrainReceipt(
                                    new RuntimeDrainReceipt(
                                            draining.getBindingId(),
                                            draining.getGeneration(),
                                            draining.getProvisionSeed().getProvisionRequestId(),
                                            draining.getResourceHandle(),
                                            Instant.now())));
        }

        private String text(String sql, Object parameter) throws Exception {
            try (var connection = source.getConnection();
                    var statement = connection.prepareStatement(sql)) {
                statement.setObject(1, parameter);
                try (var rows = statement.executeQuery()) {
                    if (!rows.next()) {
                        throw new IllegalStateException("Missing fixture row");
                    }
                    return rows.getString(1);
                }
            }
        }

        private void alias(String aliasTenant, String storage) throws Exception {
            execute(
                    "INSERT INTO"
                        + " ma_storage(alias_key,tenant_key,storage_key,tenant_id,storage_id,physical_key,registration_state,storage_kind,registration_revision,registration_json)"
                        + " VALUES(?,?,?,?,?,?,'REGISTERED','LOCAL',1,'{}')",
                    JdbcRuntimeBindingRepository.storageAliasKey(aliasTenant, storage),
                    JdbcRuntimeBindingRepository.storageFenceKey(aliasTenant),
                    JdbcRuntimeBindingRepository.storageFenceKey(storage),
                    aliasTenant.getBytes(StandardCharsets.UTF_8),
                    storage.getBytes(StandardCharsets.UTF_8),
                    physical);
        }

        private void holder(String bindingId, long generation) throws Exception {
            String holder =
                    HexFormat.of()
                            .formatHex(
                                    MessageDigest.getInstance("SHA-256")
                                            .digest(
                                                    (bindingId + "\0" + generation + "\0original")
                                                            .getBytes(StandardCharsets.UTF_8)));
            execute(
                    "UPDATE ma_storage_owner SET"
                            + " holder_key=?,binding_id=?,runtime_generation=?,runtime_session_id=?"
                            + " WHERE storage_key=?",
                    holder,
                    bindingId.getBytes(StandardCharsets.UTF_8),
                    generation,
                    "original".getBytes(StandardCharsets.UTF_8),
                    physical);
        }

        private RuntimeSessionRecord release() {
            return bindings.completeStoppedSessionRelease(sessions, executions, session, binding);
        }

        private String holder() throws Exception {
            try (var connection = source.getConnection();
                    var statement =
                            connection.prepareStatement(
                                    "SELECT holder_key FROM ma_storage_owner WHERE"
                                            + " storage_key=?")) {
                statement.setString(1, physical);
                try (var row = statement.executeQuery()) {
                    assertEquals(true, row.next());
                    return row.getString(1);
                }
            }
        }

        private void unreleased() {
            assertEquals(
                    RuntimeSessionRecord.State.RELEASING,
                    sessions.findById(binding.getRequest().getScope(), "original").getState());
        }

        private long scalar(String sql, String key) throws Exception {
            try (var connection = source.getConnection();
                    var statement = connection.prepareStatement(sql)) {
                statement.setString(1, key);
                try (var row = statement.executeQuery()) {
                    assertEquals(true, row.next());
                    return row.getLong(1);
                }
            }
        }

        private void execute(String sql, Object... arguments) throws Exception {
            try (var connection = source.getConnection();
                    var statement = connection.prepareStatement(sql)) {
                for (int index = 0; index < arguments.length; index++) {
                    statement.setObject(index + 1, arguments[index]);
                }
                statement.executeUpdate();
            }
        }
    }
}
