package com.alibaba.qwen.code.runtimebroker.managedworkspace;

import org.junit.jupiter.api.Test;

import static com.alibaba.qwen.code.runtimebroker.managedworkspace.TestWorkspaces.copy;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

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
        assertThrows(IllegalArgumentException.class,
                () -> new WorkspaceActor("tenant-a", "alice@example.com "));
        assertFalse(actor.equals(null));
        assertFalse(actor.equals("tenant-a"));
    }

    @Test
    void acceptsAnActorIdOfUpTo36CodePoints() {
        String cjk = "界";
        assertEquals(36, new WorkspaceActor("tenant-a", cjk.repeat(36))
                .getActorId().length());
        assertThrows(IllegalArgumentException.class,
                () -> new WorkspaceActor("tenant-a", cjk.repeat(37)));
        // Interior spaces count and are kept; trailing spaces are refused
        // so a PAD SPACE collation cannot fold two actors together.
        assertEquals("a b", new WorkspaceActor("tenant-a", "a b").getActorId());
        assertThrows(IllegalArgumentException.class,
                () -> new WorkspaceActor("tenant-a", " "));
        assertThrows(IllegalArgumentException.class,
                () -> new WorkspaceActor("tenant-a", "x".repeat(35) + " "));
        assertThrows(IllegalArgumentException.class,
                () -> new WorkspaceActor("tenant-a", "x".repeat(36) + " "));
    }

    @Test
    void rejectsAnInvalidTenant() {
        for (String tenantId : new String[] {null, "", "tenant/a", "tenant a",
                "t".repeat(37)}) {
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
