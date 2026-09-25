package com.alibaba.qwen.code.managedworkspace;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.util.List;
import org.junit.jupiter.api.Test;

class WorkspaceRelativePathTest {
    @Test
    void normalizesSeparatorsAndDotSegments() {
        assertEquals(".", WorkspaceRelativePath.normalize("."));
        assertEquals(".", WorkspaceRelativePath.normalize(".//./"));
        assertEquals("services/api",
                WorkspaceRelativePath.normalize("./services//./api/"));
    }

    @Test
    void keepsSpacesCaseAndUnicodeUnchanged() {
        assertEquals(" a /B ", WorkspaceRelativePath.normalize(" a /B "));
        assertEquals("café",
                WorkspaceRelativePath.normalize("café"));
        assertEquals("%2e%2e/..a/...",
                WorkspaceRelativePath.normalize("%2e%2e/..a/..."));
    }

    @Test
    void rejectsEveryLexicalViolationWithoutEchoingTheInput() {
        List<String> invalid = List.of("", "/a", "C:x", "z:", "./C:x",
                ".//c:/x", "./Z:", "a\\b", "..", "../a", "a/../b", "a/..",
                "a\u0000b", "a\nb", "a\u007fb", "a\u009bb", "a\ud800",
                "\udc00a", "a".repeat(1025));
        for (String value : invalid) {
            WorkspaceException error = assertThrows(WorkspaceException.class,
                    () -> WorkspaceRelativePath.normalize(value), value);
            assertEquals("invalid_cwd", error.getCode(), value);
            assertEquals(400, error.getStatusCode(), value);
            if (!value.isEmpty()) {
                assertFalse(error.getMessage().contains(value), value);
            }
        }
    }

    @Test
    void allowsAColonThatIsNotADrivePrefix() {
        assertEquals("ab:c", WorkspaceRelativePath.normalize("ab:c"));
        assertEquals("a/C:x", WorkspaceRelativePath.normalize("./a/C:x"));
    }

    @Test
    void countsLengthInCodePoints() {
        String clef = "𝄞";
        assertEquals(clef.repeat(1024),
                WorkspaceRelativePath.normalize(clef.repeat(1024)));
        assertThrows(WorkspaceException.class,
                () -> WorkspaceRelativePath.normalize(clef.repeat(1025)));
    }

    @Test
    void appliesTheLengthLimitBeforeNormalizing() {
        assertThrows(WorkspaceException.class,
                () -> WorkspaceRelativePath.normalize("./".repeat(513)));
    }

    @Test
    void treatsNullAsAProgrammingError() {
        assertThrows(IllegalArgumentException.class,
                () -> WorkspaceRelativePath.normalize(null));
    }
}
