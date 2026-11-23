package com.alibaba.qwen.code.runtimebroker.managedworkspace;

import org.junit.jupiter.api.Test;

import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ChildActorIdTest {
    @Test
    void staysInsideTheActorBudgetAndIsDeterministic() {
        String parent = UUID.randomUUID().toString();
        String actor = ChildActorId.of(parent);
        assertEquals(34, actor.length());
        assertTrue(actor.startsWith("c:"));
        assertEquals(actor, ChildActorId.of(parent));
        assertNotEquals(actor, ChildActorId.of(UUID.randomUUID().toString()));
    }

    @Test
    void rejectsMissingOrMalformedParentIdentity() {
        assertThrows(IllegalArgumentException.class, () -> ChildActorId.of(null));
        assertThrows(IllegalArgumentException.class, () -> ChildActorId.of(""));
        assertThrows(IllegalArgumentException.class, () -> ChildActorId.of("a\ud800b"));
    }
}
