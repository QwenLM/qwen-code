package com.alibaba.qwen.code.runtimebroker.managedworkspace;

import static com.alibaba.qwen.code.runtimebroker.managedworkspace.TestWorkspaces.copy;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import org.junit.jupiter.api.Test;

class WorkspaceActorTest {
    @Test
    void keepsTheAuthenticatedIdentity() {
        WorkspaceActor actor = new WorkspaceActor("tenant-a", "alice@example.com");

        assertEquals("tenant-a", actor.getTenantId());
        assertEquals("alice@example.com", actor.getActorId());
        assertEquals(new WorkspaceActor("tenant-a", "alice@example.com"), actor);
        assertEquals(new WorkspaceActor(copy("tenant-a"),
                copy("alice@example.com")), actor);
        assertEquals(new WorkspaceActor("tenant-a", "alice@example.com")
                .hashCode(), actor.hashCode());
        assertNotEquals(new WorkspaceActor("tenant-b", "alice@example.com"),
                actor);
        assertNotEquals(new WorkspaceActor("tenant-a", "bob@example.com"),
                actor);
        assertNotEquals(new WorkspaceActor("TENANT-A", "alice@example.com"),
                actor);
        assertNotEquals(new WorkspaceActor("tenant-a", "Alice@example.com"),
                actor);
        assertNotEquals(new WorkspaceActor("tenant-a", "alice@example.com "),
                actor);
        assertFalse(actor.equals(null));
        assertFalse(actor.equals("tenant-a"));
    }

    @Test
    void acceptsAnActorIdOfUpTo512CodePoints() {
        String clef = "\uD834\uDD1E";
        assertEquals(1024, new WorkspaceActor("tenant-a", clef.repeat(512))
                .getActorId().length());
        assertThrows(IllegalArgumentException.class,
                () -> new WorkspaceActor("tenant-a", clef.repeat(513)));
        // Spaces count and are kept.
        assertEquals(" ", new WorkspaceActor("tenant-a", " ").getActorId());
        assertEquals(512, new WorkspaceActor("tenant-a", "x".repeat(511) + " ")
                .getActorId().length());
        assertThrows(IllegalArgumentException.class,
                () -> new WorkspaceActor("tenant-a", "x".repeat(512) + " "));
    }

    @Test
    void rejectsAnInvalidTenant() {
        for (String tenantId : new String[] {null, "", "tenant/a", "tenant a",
                "t".repeat(129)}) {
            assertThrows(IllegalArgumentException.class,
                    () -> new WorkspaceActor(tenantId, "alice"),
                    String.valueOf(tenantId));
        }
    }

    @Test
    void rejectsAnInvalidActorId() {
        for (String actorId : new String[] {null, "", "alice\n", "alice\u009b",
                "alice\ud800"}) {
            assertThrows(IllegalArgumentException.class,
                    () -> new WorkspaceActor("tenant-a", actorId),
                    String.valueOf(actorId));
        }
    }
}
