package com.alibaba.qwen.code.managedworkspace;

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
    }

    @Test
    void treatsMissingValuesAsProgrammingErrors() {
        assertThrows(IllegalArgumentException.class,
                () -> WorkspaceSelection.explicit(null));
        assertThrows(IllegalArgumentException.class,
                () -> WorkspaceSelection.explicit("ws-a", null));
    }
}
