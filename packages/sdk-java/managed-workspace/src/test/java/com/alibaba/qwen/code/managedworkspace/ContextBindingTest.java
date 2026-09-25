package com.alibaba.qwen.code.managedworkspace;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.function.Consumer;
import org.junit.jupiter.api.Test;

class ContextBindingTest {
    @Test
    void derivesThePinnedDigestOfTheRootFixture() {
        ContextBinding binding = new Values().build();

        assertEquals("sha256:53806bd3c066c6594c331e02a3a88df2ff50f334a793fa5"
                + "79837fb99a5b3d1dd", binding.getContextDigest());
    }

    @Test
    void encodesLengthPrefixedUtf8ItemsInFieldOrder() {
        Values values = new Values();
        values.cwdRelative = "项目";
        ByteBuffer encoded = ByteBuffer.wrap(values.build().encode());

        List<String> items = List.of(ContextBinding.DOMAIN_TAG, "tenant-a",
                "ws_project_a", "7", "storage://pvc/project-a", "项目",
                "config:bundle-3@r12", "1");
        for (String item : items) {
            byte[] expected = item.getBytes(StandardCharsets.UTF_8);
            byte[] actual = new byte[encoded.getInt()];
            encoded.get(actual);
            assertArrayEquals(expected, actual, item);
        }
        assertEquals(0, encoded.remaining());
    }

    @Test
    void writesSixtyFourBitIntegersAsDecimalText() {
        Values values = new Values();
        values.generation = Long.MAX_VALUE;
        values.revision = 9_007_199_254_740_993L;
        String encoded = new String(values.build().encode(),
                StandardCharsets.UTF_8);

        assertTrue(encoded.contains("9223372036854775807"));
        assertTrue(encoded.contains("9007199254740993"));
    }

    @Test
    void changesTheDigestWhenAnyFieldChanges() {
        List<Consumer<Values>> changes = List.of(
                values -> values.tenantId = "tenant-b",
                values -> values.workspaceId = "ws_project_b",
                values -> values.generation = 8,
                values -> values.storageId = "storage://pvc/project-b",
                values -> values.cwdRelative = "services",
                values -> values.configRef = "config:bundle-4",
                values -> values.revision = 2);
        Set<String> digests = new HashSet<>();
        digests.add(new Values().build().getContextDigest());
        for (Consumer<Values> change : changes) {
            Values values = new Values();
            change.accept(values);
            digests.add(values.build().getContextDigest());
        }
        assertEquals(changes.size() + 1, digests.size());
    }

    @Test
    void separatesFieldsSoConcatenationCannotCollide() {
        Values first = new Values();
        first.tenantId = "ab";
        first.workspaceId = "c";
        Values second = new Values();
        second.tenantId = "a";
        second.workspaceId = "bc";

        assertNotEquals(first.build().getContextDigest(),
                second.build().getContextDigest());
    }

    @Test
    void acceptsOnlyANormalizedDirectory() {
        for (String cwd : new String[] {"./services", "services/", "a//b",
                "../x", "/abs", "", null}) {
            Values values = new Values();
            values.cwdRelative = cwd;
            assertThrows(IllegalArgumentException.class, values::build,
                    String.valueOf(cwd));
        }
    }

    @Test
    void validatesEveryOtherField() {
        assertInvalid(values -> values.tenantId = "tenant/a");
        assertInvalid(values -> values.workspaceId = "");
        assertInvalid(values -> values.generation = 0);
        assertInvalid(values -> values.storageId = "storage a");
        assertInvalid(values -> values.configRef = "config:é");
        assertInvalid(values -> values.configRef = "c".repeat(513));
        assertInvalid(values -> values.revision = 0);
    }

    @Test
    void comparesByItsFields() {
        assertEquals(new Values().build(), new Values().build());
        assertEquals(new Values().build().hashCode(),
                new Values().build().hashCode());
        Values changed = new Values();
        changed.revision = 2;
        assertNotEquals(new Values().build(), changed.build());
    }

    private static void assertInvalid(Consumer<Values> change) {
        Values values = new Values();
        change.accept(values);
        assertThrows(IllegalArgumentException.class, values::build);
    }

    private static final class Values {
        private String tenantId = "tenant-a";
        private String workspaceId = "ws_project_a";
        private long generation = 7;
        private String storageId = "storage://pvc/project-a";
        private String cwdRelative = ".";
        private String configRef = "config:bundle-3@r12";
        private long revision = 1;

        ContextBinding build() {
            return new ContextBinding(tenantId, workspaceId, generation,
                    storageId, cwdRelative, configRef, revision);
        }
    }
}
