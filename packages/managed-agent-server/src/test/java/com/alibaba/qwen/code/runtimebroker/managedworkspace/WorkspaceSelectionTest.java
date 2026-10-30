package com.alibaba.qwen.code.runtimebroker.managedworkspace;

import static com.alibaba.qwen.code.runtimebroker.managedworkspace.TestWorkspaces.copy;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;

class WorkspaceSelectionTest {
    @Test
    void describesAnOmittedSelection() {
        WorkspaceSelection omitted = WorkspaceSelection.omitted();

        assertTrue(omitted.isOmitted());
        assertTrue(omitted.getWorkspaceId().isEmpty());
        assertEquals(".", omitted.getCwdRelative());
        assertEquals(List.of("omitted"), omitted.digestFields());
    }

    @Test
    void normalizesTheDirectoryOfAnExplicitSelection() {
        WorkspaceSelection selection = WorkspaceSelection.explicit("ws-a",
                "./services//api/");

        assertFalse(selection.isOmitted());
        assertEquals("ws-a", selection.getWorkspaceId().orElseThrow());
        assertEquals("services/api", selection.getCwdRelative());
        assertEquals(List.of("explicit", "ws-a", "services/api"),
                selection.digestFields());
        assertEquals(".", WorkspaceSelection.explicit("ws-a")
                .getCwdRelative());
    }

    @Test
    void digestsSpellingsOfOneDirectoryAlike() {
        WorkspaceSelection spelled = WorkspaceSelection.explicit("ws-a",
                "./a//b/.");
        WorkspaceSelection plain = WorkspaceSelection.explicit("ws-a", "a/b");

        assertEquals(plain, spelled);
        assertEquals(plain.hashCode(), spelled.hashCode());
        assertEquals(plain.digestFields(), spelled.digestFields());
        assertNotEquals(plain, WorkspaceSelection.explicit("ws-a", "a/c"));
        assertNotEquals(plain, WorkspaceSelection.explicit("ws-b", "a/b"));
        assertEquals(plain, WorkspaceSelection.explicit(copy("ws-a"),
                "a/b"));
        assertNotEquals(plain, WorkspaceSelection.explicit("WS-A", "a/b"));
        assertNotEquals(plain, WorkspaceSelection.explicit("ws-a", "A/b"));
        assertFalse(plain.equals(null));
        assertFalse(plain.equals("ws-a"));
        assertFalse(WorkspaceSelection.omitted().equals(null));
    }

    @Test
    void neverDigestsOmissionLikeAnExplicitChoice() {
        assertNotEquals(WorkspaceSelection.omitted().digestFields(),
                WorkspaceSelection.explicit("omitted").digestFields());
        assertNotEquals(WorkspaceSelection.omitted(),
                WorkspaceSelection.explicit("ws-a"));
    }

    @Test
    void rejectsAnInvalidDirectoryWhenBuilt() {
        WorkspaceException error = assertThrows(WorkspaceException.class,
                () -> WorkspaceSelection.explicit("ws-a", "a/../b"));

        assertEquals("invalid_cwd", error.getCode());
    }

    @Test
    void keepsAnyWorkspaceIdForResolutionToReject() {
        assertEquals("../x", WorkspaceSelection.explicit("../x")
                .getWorkspaceId().orElseThrow());
        assertEquals(" ws-a", WorkspaceSelection.explicit(" ws-a")
                .getWorkspaceId().orElseThrow());
    }

    @Test
    void treatsMissingValuesAsProgrammingErrors() {
        assertThrows(IllegalArgumentException.class,
                () -> WorkspaceSelection.explicit(null));
        assertThrows(IllegalArgumentException.class,
                () -> WorkspaceSelection.explicit("ws-a", null));
    }
}
