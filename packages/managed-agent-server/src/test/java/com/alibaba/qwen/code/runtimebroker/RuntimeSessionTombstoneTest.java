package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.runtimebroker.security.AesGcmSecretProtector;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.time.Duration;
import java.time.Instant;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

class RuntimeSessionTombstoneTest {
    private static final RuntimeScope SCOPE = new RuntimeScope(
            "tenant", "workspace", "generation", "/workspace", "capability", "session");

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void retirementUsesReleaseRulesAndKeepsAdmissionClosed(boolean jdbc) {
        var fixture = fixture(jdbc);
        var binding = fixture.binding;
        binding = fixture.bindings.compareAndSet(binding,
                binding.withState(RuntimeBindingRecord.State.DRAINING, null, Instant.now())
                        .withDrainRequested(true, Instant.now()));
        fixture.bindings.requestHarnessDrain("tenant", "harness");
        var tombstone = record(binding, "runtime", RuntimeSessionRecord.State.RELEASED);
        assertEquals(RuntimeSessionRecord.State.RELEASED,
                fixture.bindings.createSessionTombstone(fixture.sessions, tombstone).getState());
        assertEquals(RuntimeSessionRecord.State.RELEASED,
                fixture.bindings.createSessionTombstone(fixture.sessions, tombstone).getState());
        var closed = binding;
        var failure = assertThrows(RuntimeBrokerException.class,
                () -> fixture.bindings.admitSession(fixture.sessions,
                        record(closed, "new-runtime", RuntimeSessionRecord.State.ACQUIRING)));
        assertEquals("runtime_admission_closed", failure.getCode());
        assertNull(fixture.sessions.findById(SCOPE, "new-runtime"));
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void tombstoneCannotOverwriteAnAcquiredOwnerOrOpenAdmission(boolean jdbc) {
        var fixture = fixture(jdbc);
        var acquired = fixture.bindings.admitSession(fixture.sessions,
                record(fixture.binding, "runtime", RuntimeSessionRecord.State.ACQUIRING));
        assertEquals(acquired.getState(), fixture.bindings.createSessionTombstone(fixture.sessions,
                record(fixture.binding, "runtime", RuntimeSessionRecord.State.RELEASED)).getState());
        assertThrows(IllegalArgumentException.class,
                () -> fixture.bindings.createSessionTombstone(fixture.sessions,
                        record(fixture.binding, "new-runtime", RuntimeSessionRecord.State.READY)));
        assertNull(fixture.sessions.findById(SCOPE, "new-runtime"));
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void retirementRejectsAnUnreconciledOriginalGeneration(boolean jdbc) {
        var fixture = fixture(jdbc);
        var binding = fixture.binding;
        fixture.bindings.compareAndSet(binding,
                binding.withState(RuntimeBindingRecord.State.LOST, null, Instant.now()));
        var failure = assertThrows(RuntimeBrokerException.class,
                () -> fixture.bindings.createSessionTombstone(fixture.sessions,
                        record(binding, "runtime", RuntimeSessionRecord.State.RELEASED)));
        assertEquals("runtime_reconciliation_required", failure.getCode());
        assertEquals(503, failure.getStatusCode());
        assertNull(fixture.sessions.findById(SCOPE, "runtime"));
    }

    private static RuntimeSessionRecord record(RuntimeBindingRecord binding, String id,
            RuntimeSessionRecord.State state) {
        return new RuntimeSessionRecord(new RuntimeSession("harness", id, "bootstrap", SCOPE),
                binding.getBindingId(), binding.getGeneration(), state, 0, Instant.now());
    }

    private static Fixture fixture(boolean jdbc) {
        RuntimeBindingRepository bindings;
        RuntimeSessionRepository sessions;
        if (jdbc) {
            var source = new JdbcDataSource();
            source.setURL("jdbc:h2:mem:tombstone-" + UUID.randomUUID()
                    + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
            com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema.initialize(source);
            bindings = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("test", new byte[32]));
            sessions = new JdbcRuntimeSessionRepository(source);
        } else {
            bindings = new InMemoryRuntimeBindingRepository();
            sessions = new InMemoryRuntimeSessionRepository();
        }
        var binding = bindings.findOrCreate(new RuntimeProvisionRequest(SCOPE, "harness"));
        binding = bindings.claimOperation(binding.getBindingId(), "test-owner", Duration.ofMinutes(1));
        binding = bindings.compareAndSet(binding,
                binding.withState(RuntimeBindingRecord.State.READY, null, Instant.now()));
        return new Fixture(bindings, sessions, binding);
    }

    private record Fixture(RuntimeBindingRepository bindings, RuntimeSessionRepository sessions,
            RuntimeBindingRecord binding) {}
}
