package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.*;

import java.time.Instant;
import org.junit.jupiter.api.Test;

class WorkspaceMigrationRepositoryTest {
    @Test
    void fencesOnlyTheExactStorageWithoutClosingTheHarness() {
        var repository = new InMemoryRuntimeBindingRepository();
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
        var repository = new InMemoryRuntimeSessionRepository();
        var old = new RuntimeScope("tenant", "workspace", "1", "/old", "capability", "session");
        var target = new RuntimeScope("tenant", "workspace", "1", "/target", "capability", "session");
        var first = new RuntimeSessionRecord(new RuntimeSession("harness", "runtime", "bootstrap", old),
                "binding-old", 1, RuntimeSessionRecord.State.ACQUIRING, 0, Instant.now());
        repository.findOrCreate(first);
        assertSame(first, repository.findHistorical("tenant", "harness", "runtime"));
        assertNull(repository.findById(target, "runtime"));
        assertNull(repository.findHistorical("other-tenant", "harness", "runtime"));
        repository.findOrCreate(new RuntimeSessionRecord(new RuntimeSession("harness", "runtime", "bootstrap", target),
                "binding-new", 1, RuntimeSessionRecord.State.ACQUIRING, 0, Instant.now()));
        assertThrows(IllegalStateException.class, () -> repository.findHistorical("tenant", "harness", "runtime"));
    }
}
