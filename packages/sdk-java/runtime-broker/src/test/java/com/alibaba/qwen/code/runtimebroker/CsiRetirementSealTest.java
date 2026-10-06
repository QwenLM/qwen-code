package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.net.URI;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;

class CsiRetirementSealTest {
    @Test
    void originalCsiHandleIsImmutableBeforeRetirementInMemoryAndJdbc() {
        for (RuntimeBindingRepository bindings : java.util.List.of(new InMemoryRuntimeBindingRepository(),
                new JdbcRuntimeBindingRepository(source(), new AesGcmSecretProtector("test", new byte[32])))) {
            var original = binding(bindings, "kubernetes-workspace");
            assertThrows(IllegalArgumentException.class, () -> bindings.compareAndSet(original,
                    original.withResourceHandle(new RuntimeResourceHandle("kubernetes-workspace", 3,
                            Map.of("pod", "replacement")), Instant.now())));
            assertThrows(IllegalArgumentException.class, () -> bindings.compareAndSet(original,
                    original.withResourceHandle(null, Instant.now())));
            assertNotNull(bindings.compareAndSet(original, original.withResourceHandle(original.getResourceHandle(), Instant.now())));
        }
    }

    @Test
    void memoryCannotReopenOrReleaseASealedCsiBinding() {
        verify(new InMemoryRuntimeBindingRepository());
    }

    @Test
    void jdbcCannotReopenOrReleaseASealedCsiBinding() {
        var source = source();
        verify(new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("test", new byte[32])));
    }

    @Test
    void retirementLockRequiresTheOriginalSlotAndAnActiveTransaction() throws Exception {
        var source = source();
        var bindings = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("test", new byte[32]));
        var original = binding(bindings, "kubernetes-workspace");
        try (var connection = source.getConnection()) {
            assertThrows(IllegalArgumentException.class, () -> bindings.lockActiveForRetirement(connection, original));
            assertThrows(IllegalArgumentException.class, () -> bindings.sealForRetirement(connection, original));
            connection.setAutoCommit(false);
            assertEquals(original.getBindingId(), bindings.lockActiveForRetirement(connection, original).getBindingId());
            var sealed = bindings.sealForRetirement(connection, original);
            assertEquals(RuntimeBindingRecord.State.DRAINING, sealed.getState());
            connection.rollback();
        }
        assertEquals(RuntimeBindingRecord.State.READY, bindings.findById(original.getBindingId()).getState());
        try (var connection = source.getConnection()) {
            connection.setAutoCommit(false);
            try (var sql = connection.prepareStatement("UPDATE qwen_runtime_binding_slot SET active_binding_id = 'foreign'")) {
                sql.executeUpdate();
            }
            assertThrows(IllegalStateException.class, () -> bindings.sealForRetirement(connection, original));
            connection.rollback();
        }
    }

    private static void verify(RuntimeBindingRepository bindings) {
        var original = binding(bindings, "kubernetes-workspace");
        var sealed = bindings.compareAndSet(original, original.withState(RuntimeBindingRecord.State.DRAINING,
                original.getLease(), Instant.now()).withDrainRequested(true, Instant.now()));
        assertNotNull(sealed);
        var fresh = bindings.claimOperation(sealed.getBindingId(), original.getOperationOwner(), Duration.ofMinutes(1));
        for (var state : new RuntimeBindingRecord.State[] {RuntimeBindingRecord.State.READY,
                RuntimeBindingRecord.State.PROVISIONING, RuntimeBindingRecord.State.RECOVERY_BLOCKED,
                RuntimeBindingRecord.State.FAILED, RuntimeBindingRecord.State.RELEASED, RuntimeBindingRecord.State.LOST}) {
            assertThrows(IllegalArgumentException.class, () -> bindings.compareAndSet(fresh,
                    fresh.withState(state, fresh.getLease(), Instant.now())));
        }
        assertThrows(IllegalArgumentException.class, () -> bindings.compareAndSet(fresh, fresh.withDrainRequested(false, Instant.now())));
        assertThrows(IllegalArgumentException.class, () -> bindings.compareAndSet(fresh,
                fresh.withResourceHandle(new RuntimeResourceHandle("kubernetes-workspace", 3, Map.of("pod", "foreign")), Instant.now())));
        assertNotNull(bindings.compareAndSet(fresh, fresh.withLastHealthAt(Instant.now(), Instant.now())));
        assertEquals(fresh.getBindingId(), bindings.findOrCreate(fresh.getRequest()).getBindingId());
        var local = binding(bindings, "test-supervisor");
        var drained = bindings.compareAndSet(local, local.withState(RuntimeBindingRecord.State.DRAINING,
                local.getLease(), Instant.now()).withDrainRequested(true, Instant.now()));
        assertEquals(RuntimeBindingRecord.State.RELEASED, bindings.compareAndSet(drained,
                drained.withState(RuntimeBindingRecord.State.RELEASED, drained.getLease(), Instant.now())).getState());
    }

    private static RuntimeBindingRecord binding(RuntimeBindingRepository bindings, String kind) {
        String id = UUID.randomUUID().toString();
        var request = new RuntimeProvisionRequest(new RuntimeScope(id, "workspace", "1", "/workspace", "sha256:" + "a".repeat(64), "workspace"),
                null, kind, "storage");
        var created = bindings.findOrCreate(request);
        var claimed = bindings.claimOperation(created.getBindingId(), "coordinator", Duration.ofMinutes(5));
        var seed = claimed.getProvisionSeed();
        var lease = new RuntimeLease(seed.getProvisionalRuntimeId(), URI.create("http://127.0.0.1:9"), seed.getToken(), seed.getLeaseId(), seed.getEpoch());
        return bindings.compareAndSet(claimed, claimed.withAttestation(lease,
                new RuntimeResourceHandle(kind, 3, Map.of("pod", "original")), Instant.now(), Instant.now()));
    }

    private static JdbcDataSource source() {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:seal-" + UUID.randomUUID() + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        JdbcRuntimeBrokerSchema.initialize(source);
        return source;
    }
}
