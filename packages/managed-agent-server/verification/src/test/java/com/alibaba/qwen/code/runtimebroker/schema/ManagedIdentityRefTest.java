package com.alibaba.qwen.code.runtimebroker.schema;

import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ManagedIdentityRefTest {
    @Test
    void roundTripsAReadableTupleWithNullEmptyAndEscapedComponents() {
        byte[] encoded = ManagedIdentityRef.encode(
                256, "tenant-1", null, "", "中文 |%");
        String text = new String(encoded, StandardCharsets.US_ASCII);
        assertTrue(text.startsWith("v1|4|8:tenant-1|-|0:|9:"));
        assertTrue(text.contains("%E4%B8%AD%E6%96%87%20%7C%25"));
        assertEquals(Arrays.asList("tenant-1", null, "", "中文 |%"),
                ManagedIdentityRef.decode(encoded));
        assertArrayEquals(encoded, ManagedIdentityRef.encode(
                encoded.length, "tenant-1", null, "", "中文 |%"));
    }

    @Test
    void preservesTupleBoundariesAndNullVersusEmpty() {
        assertFalse(Arrays.equals(
                ManagedIdentityRef.encode(128, "ab", "c"),
                ManagedIdentityRef.encode(128, "a", "bc")));
        assertFalse(Arrays.equals(
                ManagedIdentityRef.encode(128, "ab|c"),
                ManagedIdentityRef.encode(128, "ab", "c")));
        assertFalse(Arrays.equals(
                ManagedIdentityRef.encode(128, (String) null),
                ManagedIdentityRef.encode(128, "")));
        assertEquals(List.of("-"), ManagedIdentityRef.decode(
                ManagedIdentityRef.encode(128, "-")));
    }

    @Test
    void enforcesTheExactEncodedByteBudget() {
        byte[] encoded = ManagedIdentityRef.encode(128, "租户");
        assertArrayEquals(encoded,
                ManagedIdentityRef.encode(encoded.length, "租户"));
        assertThrows(IllegalArgumentException.class,
                () -> ManagedIdentityRef.encode(encoded.length - 1, "租户"));
        assertThrows(IllegalArgumentException.class,
                () -> ManagedIdentityRef.encode(0, "tenant"));
        assertThrows(IllegalArgumentException.class,
                () -> ManagedIdentityRef.encode(128));
        assertThrows(IllegalArgumentException.class,
                () -> ManagedIdentityRef.encode(128, (String[]) null));
    }

    @Test
    void actorScopeFitsTheWidestAdmittedActor() {
        String ref = ManagedIdentityRefs.actorScopeRef(
                "t".repeat(36), "s".repeat(64), "𝄞".repeat(36));
        assertEquals(549, ref.length());
        assertTrue(ref.length() <= ManagedIdentityRefs.ACTOR_SCOPE_REF_BYTES);
    }

    @Test
    void rejectsMalformedUnicodeInsteadOfReplacingIt() {
        assertThrows(IllegalArgumentException.class,
                () -> ManagedIdentityRef.encode(128, "a\ud800b"));
    }

    @Test
    void rejectsMalformedAndNonCanonicalReferences() {
        assertThrows(IllegalArgumentException.class,
                () -> ManagedIdentityRef.decode(null));
        for (String invalid : List.of(
                "v2|1|1:a", "v1|0|", "v1|1|2:a", "v1|1|1:%e4",
                "v1|1|1:a|", "v1|01|1:a", "v1|1|01:a", "v1|1|1:%4G",
                "v1|1|1:中", "v1|1|1:%C3", "v1|1|1:+",
                "v1|1|1:a%20", "v1|1|1:%61", "v1|1|1:%C",
                "v1|999999999999|1:a")) {
            assertThrows(IllegalArgumentException.class,
                    () -> ManagedIdentityRef.decode(
                            invalid.getBytes(StandardCharsets.UTF_8)), invalid);
        }
    }
}
