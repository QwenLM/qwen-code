package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.net.URI;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import javax.sql.DataSource;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;

class JdbcPlacementGuardTest {
    @Test
    void jdbcMatchesInMemoryStateAndPlacementScopeDecisions() throws Exception {
        RuntimeProvisionRequest existing = request("tenant", "workspace", "/workspace", "storage", "local-process");
        List<RuntimeProvisionRequest> candidates = List.of(
                request("tenant", "workspace", "/elsewhere", "other-storage", "static"),
                request("tenant", "other-workspace", "/workspace", "other-storage", "static"),
                request("tenant", "other-workspace", "/elsewhere", "storage", "local-process"),
                request("tenant", "other-workspace", "/elsewhere", "other-storage", "local-process"),
                request("other-tenant", "workspace", "/workspace", "storage", "local-process"));
        for (RuntimeBindingRecord.State state : RuntimeBindingRecord.State.values()) {
            for (RuntimeProvisionRequest candidate : candidates) {
                Fixture fixture = new Fixture(false);
                RuntimeBindingRecord history = fixture.history(existing, state, true, false, 0);
                assertAdmissionMatches(fixture, history, candidate);
            }
        }
        for (RuntimeBindingRecord.State state : RuntimeBindingRecord.State.values()) {
            for (String kind : List.of("legacy", "local-process", "kubernetes-workspace")) {
                for (boolean seeded : List.of(false, true)) {
                    if (state == RuntimeBindingRecord.State.READY && !"legacy".equals(kind)) {
                        continue;
                    }
                    Fixture fixture = new Fixture(false);
                    RuntimeProvisionRequest request = request("tenant", "workspace", "/workspace", null, kind);
                    RuntimeBindingRecord history = fixture.history(request, state, seeded, false, 0);
                    assertAdmissionMatches(fixture, history,
                            request("tenant", "different-workspace", "/different", null, "static"));
                }
            }
        }
    }

    @Test
    void localStartupExceptionEndsAfterLeaseOrAttestation() throws Exception {
        RuntimeProvisionRequest existing = request("tenant", "workspace", "/workspace", null, "local-process");
        RuntimeProvisionRequest candidate = request("tenant", "other-workspace", "/elsewhere", null, "static");
        for (boolean leased : List.of(false, true)) {
            for (long attestation : List.of(0L, 1L)) {
                Fixture fixture = new Fixture(false);
                RuntimeBindingRecord history = fixture.history(existing,
                        RuntimeBindingRecord.State.RECOVERY_BLOCKED, true, leased, attestation);
                assertAdmissionMatches(fixture, history, candidate);
            }
        }
    }

    @Test
    void managedIdentityComparisonsStayExactWithCaseInsensitiveDatabaseColumns() throws Exception {
        RuntimeProvisionRequest existing = request("Tenant", "Workspace", "/Workspace", "Storage", "local-process");
        for (RuntimeProvisionRequest candidate : List.of(
                request("tenant", "Workspace", "/Workspace", "Storage", "local-process"),
                request("Tenant", "workspace", "/elsewhere", "different", "local-process"),
                request("Tenant", "different", "/workspace", "different", "local-process"),
                request("Tenant", "different", "/elsewhere", "storage", "local-process"))) {
            Fixture fixture = new Fixture(true);
            RuntimeBindingRecord history = fixture.history(existing, RuntimeBindingRecord.State.LOST, true, false, 0);
            assertAdmissionMatches(fixture, history, candidate);
        }
    }

    @Test
    void incompleteSeedAndLeaseColumnsConservativelyBlockWithoutMappingHistoricalRows() throws Exception {
        RuntimeProvisionRequest existing = request("tenant", "workspace", "/workspace", null, "local-process");
        RuntimeProvisionRequest candidate = request("tenant", "other", "/elsewhere", null, "static");
        for (String column : List.of("provision_request_id", "provision_seed_ciphertext", "credential_key_id")) {
            Fixture fixture = new Fixture(false);
            fixture.history(existing, RuntimeBindingRecord.State.FAILED, false, false, 0);
            fixture.execute("UPDATE qwen_runtime_binding SET " + column + " = ? WHERE binding_id = ?", "present", "history");
            fixture.assertBlocked(candidate);
            assertEquals(0, fixture.decrypts.get());
        }
        for (String column : List.of("runtime_instance_id", "runtime_endpoint", "runtime_lease_id", "runtime_epoch",
                "runtime_credential_ciphertext", "runtime_credential_key_id")) {
            Fixture fixture = new Fixture(false);
            fixture.history(existing, RuntimeBindingRecord.State.RECOVERY_BLOCKED, true, false, 0);
            fixture.execute("UPDATE qwen_runtime_binding SET " + column + " = ? WHERE binding_id = ?",
                    "runtime_epoch".equals(column) ? 1 : "present", "history");
            fixture.decrypts.set(0);
            fixture.assertBlocked(candidate);
            assertEquals(0, fixture.decrypts.get());
        }
    }

    @Test
    void historicalCredentialRowsAreNeverDecryptedForEitherPlacementOutcome() throws Exception {
        RuntimeProvisionRequest existing = request("tenant", "workspace", "/workspace", "storage", "local-process");
        Fixture blocked = new Fixture(false);
        blocked.history(existing, RuntimeBindingRecord.State.DRAINING, true, true, 1);
        blocked.decrypts.set(0);
        blocked.assertBlocked(request("tenant", "other", "/elsewhere", "storage", "local-process"));
        assertEquals(0, blocked.decrypts.get());

        Fixture allowed = new Fixture(false);
        allowed.history(existing, RuntimeBindingRecord.State.DRAINING, true, true, 1);
        allowed.decrypts.set(0);
        assertNotNull(allowed.bindings.findOrCreate(request("tenant", "other", "/elsewhere", "other", "local-process")));
        assertEquals(0, allowed.decrypts.get());
    }

    private static void assertAdmissionMatches(Fixture fixture, RuntimeBindingRecord history,
            RuntimeProvisionRequest candidate) {
        boolean expected = history.blocksPlacement(candidate);
        fixture.decrypts.set(0);
        if (expected) {
            fixture.assertBlocked(candidate);
        } else {
            assertNotNull(fixture.bindings.findOrCreate(candidate), history.getState().name());
        }
        assertEquals(0, fixture.decrypts.get(), "Placement decrypted history for " + history.getState());
    }

    static void verifyOnDatabase(DataSource source) throws Exception {
        Fixture fixture = new Fixture(source);
        RuntimeBindingRecord history = fixture.history(
                request("Tenant", "Workspace", "/Workspace", "Storage", "local-process"),
                RuntimeBindingRecord.State.LOST, true, true, 1);
        List<RuntimeProvisionRequest> candidates = List.of(
                request("tenant", "Workspace", "/Workspace", "Storage", "local-process"),
                request("Tenant", "workspace", "/elsewhere", "different", "local-process"),
                request("Tenant", "different", "/workspace", "different", "local-process"),
                request("Tenant", "different", "/elsewhere", "storage", "local-process"),
                request("Tenant", "different", "/elsewhere", "Storage", "local-process"),
                request("Tenant", "different", "/Workspace", "different", "local-process"),
                request("Tenant", "Workspace", "/elsewhere", "different", "local-process"));
        for (int index = 0; index < candidates.size(); index++) {
            fixture.nextId = "candidate-" + index;
            assertAdmissionMatches(fixture, history, candidates.get(index));
        }
    }

    private static RuntimeProvisionRequest request(String tenant, String workspace, String cwd,
            String storage, String kind) {
        RuntimeScope scope = new RuntimeScope(tenant, workspace, "1", cwd,
                "sha256:" + "a".repeat(64), "session");
        return new RuntimeProvisionRequest(scope, "candidate-harness", kind,
                "static".equals(kind) ? null : storage);
    }

    private static final class Fixture {
        private final DataSource source;
        private final JdbcRuntimeBindingRepository bindings;
        private final AtomicInteger decrypts = new AtomicInteger();
        private String nextId = "history";

        Fixture(boolean caseInsensitive) {
            this(h2(caseInsensitive));
        }

        private static DataSource h2(boolean caseInsensitive) {
            JdbcDataSource dataSource = new JdbcDataSource();
            dataSource.setURL("jdbc:h2:mem:placement-" + UUID.randomUUID()
                    + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE"
                    + (caseInsensitive ? ";IGNORECASE=TRUE" : ""));
            return dataSource;
        }

        Fixture(DataSource dataSource) {
            source = dataSource;
            JdbcRuntimeBrokerSchema.initialize(source);
            SecretProtector delegate = new AesGcmSecretProtector("key", new byte[32]);
            bindings = new JdbcRuntimeBindingRepository(source, new SecretProtector() {
                @Override
                public ProtectedSecret protect(String context, byte[] plaintext) {
                    return delegate.protect(context, plaintext);
                }

                @Override
                public byte[] unprotect(String context, ProtectedSecret protectedSecret) {
                    decrypts.incrementAndGet();
                    return delegate.unprotect(context, protectedSecret);
                }
            }, () -> nextId);
        }

        RuntimeBindingRecord history(RuntimeProvisionRequest request, RuntimeBindingRecord.State state,
                boolean seeded, boolean leased, long attestation) throws SQLException {
            RuntimeBindingRecord created = bindings.findOrCreate(request);
            RuntimeProvisionSeed seed = seeded ? created.getProvisionSeed() : null;
            if (seeded && seed == null) {
                seed = RuntimeProvisionSeed.create(created.getBindingId(), created.getGeneration());
                ProtectedSecret protectedSeed = new AesGcmSecretProtector("key", new byte[32])
                        .protect("runtime-provision-seed:" + JdbcRepositorySupport.valueKey(created.getBindingId()), seed.encode());
                execute("UPDATE qwen_runtime_binding SET provision_request_id = ?, provision_seed_ciphertext = ?, "
                                + "credential_key_id = ? WHERE binding_id = ?",
                        seed.getProvisionRequestId(), protectedSeed.getCiphertext(), protectedSeed.getKeyId(),
                        created.getBindingId());
            } else if (!seeded) {
                execute("UPDATE qwen_runtime_binding SET provision_request_id = NULL, provision_seed_ciphertext = NULL, "
                        + "credential_key_id = NULL WHERE binding_id = ?", created.getBindingId());
            }
            boolean durableReady = state == RuntimeBindingRecord.State.READY && request.requiresDurableIdentity();
            RuntimeLease lease = leased || durableReady
                    ? new RuntimeLease(seed.getProvisionalRuntimeId(), URI.create("http://127.0.0.1:1234"),
                    seed.getToken(), seed.getLeaseId(), seed.getEpoch()) : null;
            if (lease != null) {
                execute("UPDATE qwen_runtime_binding SET runtime_instance_id = ?, runtime_endpoint = ?, runtime_lease_id = ?, "
                                + "runtime_epoch = ? WHERE binding_id = ?", lease.getRuntimeInstanceId(),
                        lease.getEndpoint().toString(), lease.getLeaseId(), lease.getEpoch(), created.getBindingId());
            }
            RuntimeResourceHandle handle = durableReady
                    ? new RuntimeResourceHandle(request.getProvisionerKind(), 1, Map.of("worker", "history")) : null;
            long attested = durableReady ? Math.max(1, attestation) : attestation;
            if (handle != null) {
                execute("UPDATE qwen_runtime_binding SET resource_handle_version = ?, resource_handle_json = ?, "
                                + "last_reconciled_at = CURRENT_TIMESTAMP WHERE binding_id = ?",
                        handle.getVersion(), handle.toJson(), created.getBindingId());
            }
            execute("UPDATE qwen_runtime_binding SET binding_state = ?, attestation_generation = ? WHERE binding_id = ?",
                    state.name(), attested, created.getBindingId());
            execute("UPDATE qwen_runtime_binding_slot SET active_binding_id = NULL WHERE request_key = ?",
                    JdbcRepositorySupport.requestKey(request));
            nextId = "candidate";
            return new RuntimeBindingRecord(created.getBindingId(), request, seed, created.getGeneration(), state,
                    lease, handle, attested, false, null, null, 0, 0, null,
                    durableReady ? Instant.now() : null, Instant.now());
        }

        void assertBlocked(RuntimeProvisionRequest candidate) {
            RuntimeBrokerException failure = assertThrows(RuntimeBrokerException.class,
                    () -> bindings.findOrCreate(candidate));
            assertEquals("runtime_placement_recovery_required", failure.getCode());
        }

        void execute(String sql, Object... values) throws SQLException {
            try (Connection connection = source.getConnection();
                    PreparedStatement statement = connection.prepareStatement(sql)) {
                for (int index = 0; index < values.length; index++) {
                    statement.setObject(index + 1, values[index]);
                }
                statement.executeUpdate();
            }
        }
    }
}
