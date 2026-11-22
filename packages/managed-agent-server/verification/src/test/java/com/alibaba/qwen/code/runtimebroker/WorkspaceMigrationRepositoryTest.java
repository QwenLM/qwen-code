package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.runtimebroker.adapter.security.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeSessionRepository;
import org.junit.jupiter.api.Test;

import java.time.Instant;

import static org.junit.jupiter.api.Assertions.*;

class WorkspaceMigrationRepositoryTest {
    @Test
    void fencesOnlyTheExactStorageWithoutClosingTheHarness() {
        var source = new org.h2.jdbcx.JdbcDataSource();
        source.setURL("jdbc:h2:mem:migration-fence-" + java.util.UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema.initialize(source);
        var repository = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("test", new byte[32]));
        var scope = new RuntimeScope("tenant", "workspace", "1", "/old", WorkspaceExecutionProfile.CAPABILITY_DIGEST, "session");
        var original = new RuntimeProvisionRequest(scope, "session", "local-process", "storage");
        var binding = repository.findOrCreate(original);
        repository.requestStorageFence("tenant", "storage", "migration");
        assertTrue(repository.isStorageFenced("tenant", "storage", "migration"));
        assertFalse(repository.isHarnessDraining("tenant", "session"));
        assertEquals(binding.getBindingId(), repository.findByStorage("tenant", "storage", null, 50).getFirst().getBindingId());
        assertThrows(RuntimeBrokerException.class, () -> repository.findOrCreate(original));
        assertThrows(RuntimeBrokerException.class, () -> repository.requestStorageFence("tenant", "storage", "other"));
        assertNotNull(repository.findOrCreate(new RuntimeProvisionRequest(scope, "other-session", "local-process", "other-storage")));
        assertTrue(repository.findByStorage("other-tenant", "storage", null, 50).isEmpty());
    }

    @Test
    void historicalLookupKeepsOriginalScopeAndRejectsAmbiguity() {
        var source = new org.h2.jdbcx.JdbcDataSource();
        source.setURL("jdbc:h2:mem:history-" + java.util.UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema.initialize(source);
        var repository = new JdbcRuntimeSessionRepository(source);
        var old = new RuntimeScope("tenant", "workspace", "1", "/old", "capability", "session");
        var target = new RuntimeScope("tenant", "workspace", "1", "/target", "capability", "session");
        var first = new RuntimeSessionRecord(new RuntimeSession("harness", "runtime", "bootstrap", old),
                "binding-old", 1, RuntimeSessionRecord.State.ACQUIRING, 0, Instant.now());
        repository.findOrCreate(first);
        assertEquals(old, repository.findHistorical("tenant", "harness", "runtime").getSession().getScope());
        var other = new RuntimeScope("other-tenant", "workspace", "1", "/other", "capability", "session");
        repository.findOrCreate(new RuntimeSessionRecord(new RuntimeSession("harness", "runtime", "bootstrap", other),
                "binding-other", 1, RuntimeSessionRecord.State.ACQUIRING, 0, Instant.now()));
        var unrelated = new RuntimeScope("tenant", "workspace", "1", "/unrelated", "capability", "session");
        repository.findOrCreate(new RuntimeSessionRecord(new RuntimeSession("other-harness", "runtime", "bootstrap", unrelated),
                "binding-unrelated", 1, RuntimeSessionRecord.State.ACQUIRING, 0, Instant.now()));
        assertEquals(old, repository.findHistorical("tenant", "harness", "runtime").getSession().getScope());
        assertNull(repository.findById(target, "runtime"));
        assertNull(repository.findHistorical("missing-tenant", "harness", "runtime"));
        repository.findOrCreate(new RuntimeSessionRecord(new RuntimeSession("harness", "runtime", "bootstrap", target),
                "binding-new", 1, RuntimeSessionRecord.State.ACQUIRING, 0, Instant.now()));
        var ambiguity = assertThrows(RuntimeBrokerException.class,
                () -> repository.findHistorical("tenant", "harness", "runtime"));
        assertEquals(409, ambiguity.getStatusCode());
        assertEquals("runtime_session_ambiguous", ambiguity.getCode());
        assertFalse(ambiguity.isRetryable());
    }
}
