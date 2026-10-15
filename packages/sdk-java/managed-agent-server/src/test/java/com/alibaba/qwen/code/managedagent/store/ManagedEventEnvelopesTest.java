package com.alibaba.qwen.code.managedagent.store;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * Java-side pins for the mirror's byte fidelity to the TypeScript canonical
 * form, for the value classes the frozen fixtures do not cover (exponential
 * Number::toString, unpaired surrogates, long-overflowed version). The frozen
 * fixtures stay untouched; these assert the known ECMAScript outputs directly.
 */
class ManagedEventEnvelopesTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void jsNumberToStringMatchesTheEcmaScriptRules() {
        // decimal range: 1e-6 <= |x| < 1e21 renders decimal
        assertEquals("0.95", ManagedEventEnvelopes.jsNumberToString(0.95));
        assertEquals("42", ManagedEventEnvelopes.jsNumberToString(42.0));
        assertEquals("2.5", ManagedEventEnvelopes.jsNumberToString(2.5));
        assertEquals("100", ManagedEventEnvelopes.jsNumberToString(100.0));
        assertEquals("0.000001", ManagedEventEnvelopes.jsNumberToString(1e-6));
        assertEquals("123.45", ManagedEventEnvelopes.jsNumberToString(123.45));
        // exponential outside that range, with the JS sign style
        assertEquals("1e+21", ManagedEventEnvelopes.jsNumberToString(1e21));
        assertEquals("1e-7", ManagedEventEnvelopes.jsNumberToString(1e-7));
        assertEquals("-1e+21", ManagedEventEnvelopes.jsNumberToString(-1e21));
        assertEquals("0", ManagedEventEnvelopes.jsNumberToString(0.0));
    }

    @Test
    void jsNumberToStringMatchesEcmaScriptOnSubnormals() {
        // ECMAScript picks the shortest digits that round-trip; Java's
        // Double.toString diverges on these deep subnormals (wenshao's :233).
        // Expected values are Node 22's String(...) output — e.g.
        // String(5e-324) === "5e-324" where Java's Double.toString gives
        // "4.9E-324".
        assertEquals("5e-324", ManagedEventEnvelopes.jsNumberToString(5e-324));
        assertEquals("1e-323", ManagedEventEnvelopes.jsNumberToString(1e-323));
        assertEquals("1e-322", ManagedEventEnvelopes.jsNumberToString(1e-322));
        assertEquals("1e-321", ManagedEventEnvelopes.jsNumberToString(1e-321));
        assertEquals("1e-320", ManagedEventEnvelopes.jsNumberToString(1e-320));
        assertEquals("1.5e-323",
                ManagedEventEnvelopes.jsNumberToString(1.5e-323));
        assertEquals("2.5e-323",
                ManagedEventEnvelopes.jsNumberToString(2.5e-323));
        // The extreme doubles round-trip through the same rule.
        assertEquals("5e-324",
                ManagedEventEnvelopes.jsNumberToString(Double.MIN_VALUE));
        assertEquals("2.2250738585072014e-308",
                ManagedEventEnvelopes.jsNumberToString(Double.MIN_NORMAL));
        assertEquals("1.7976931348623157e+308",
                ManagedEventEnvelopes.jsNumberToString(Double.MAX_VALUE));
    }

    @Test
    void canonicalJsonRendersExponentialNumbersLikeJsonStringify()
            throws Exception {
        JsonNode node = JSON.readTree("{\"x\":1e21,\"y\":1e-7,\"z\":0.95}");
        assertEquals("{\"x\":1e+21,\"y\":1e-7,\"z\":0.95}",
                ManagedEventEnvelopes.canonicalJson(node));
    }

    @Test
    void canonicalJsonRendersALargeIntegerFromItsNearestDouble()
            throws Exception {
        // An integer above 2^53 has no exact double: JSON.stringify renders
        // the nearest double, never the exact digits. The mirror must match
        // or the digest diverges (wenshao's witness 1000000000000000128).
        JsonNode node = JSON.readTree("{\"x\":1000000000000000128}");
        assertEquals("{\"x\":1000000000000000100}",
                ManagedEventEnvelopes.canonicalJson(node));
    }

    @Test
    void canonicalJsonEscapesAnUnpairedSurrogateLikeJsonStringify() {
        // A lone high surrogate: JSON.stringify escapes it as a lowercase
        // escape (backslash, u, four hex digits) so the canonical bytes match
        // across languages. The surrogate and the backslash are built from
        // char values at runtime (never a source-level escape) so this source
        // file stays valid UTF-8 on any toolchain.
        String loneSurrogate = new String(new char[] {(char) 0xD800});
        JsonNode node = JSON.getNodeFactory().objectNode()
                .put("text", loneSurrogate);
        // Expected: {"text":"\ud800"} with a real backslash before ud800.
        String expected = "{\"text\":\"" + (char) 92 + "ud800\"}";
        assertEquals(expected, ManagedEventEnvelopes.canonicalJson(node));
    }

    @Test
    void acceptsIntegerValuedNumbersInDecimalOrExponentNotation()
            throws Exception {
        // `1e0`, `1.0` and `0.0` are integer VALUES: Number.isSafeInteger
        // accepts them on the TypeScript side, so the mirror must too.
        String raw = "{\"v\":1.0,\"sessionId\":\"s\",\"tenantId\":\"t\","
                + "\"workspaceId\":\"w\",\"stream\":\"authoritative_journal\","
                + "\"sequence\":1e0,\"eventId\":\"e\",\"kind\":\"wake.requested\","
                + "\"occurredAt\":0.0,\"payloadRef\":{\"digest\":\""
                + "a".repeat(64) + "\"}}";
        ManagedEventEnvelope envelope = ManagedEventEnvelopes.parse(
                JSON.readTree(raw));
        assertEquals(1, envelope.v());
        assertEquals(1, envelope.sequence());
        assertEquals(0, envelope.occurredAt());
    }

    @Test
    void rejectsALongOverflowedFormatVersion() {
        // PR #13940 review (Nakagawa-master): a JSON integer too big for long
        // must not be truncated to version 1. The TypeScript gate is
        // `body.v !== 1` on the parsed double; the mirror's doubleValue()
        // rounds 2^64+1 away from 1, so it rejects the same inputs. (A
        // canConvertToLong() gate would wrongly reject the accepted 1.0.)
        assertThrows(IllegalArgumentException.class,
                () -> ManagedEventEnvelopes.parse(
                        envelopeWithVersion("18446744073709551617")));
        assertThrows(IllegalArgumentException.class,
                () -> ManagedEventEnvelopes.parse(
                        envelopeWithVersion("-18446744073709551615")));
        // Control: the genuine version stays accepted, in either notation.
        assertEquals(1, assertDoesNotThrow(
                () -> ManagedEventEnvelopes.parse(envelopeWithVersion("1")))
                .v());
        assertEquals(1, assertDoesNotThrow(
                () -> ManagedEventEnvelopes.parse(envelopeWithVersion("1.0")))
                .v());
    }

    private static JsonNode envelopeWithVersion(String rawVersion)
            throws Exception {
        String raw = "{\"v\":" + rawVersion + ",\"sessionId\":\"s\","
                + "\"tenantId\":\"t\",\"workspaceId\":\"w\","
                + "\"stream\":\"authoritative_journal\",\"sequence\":1,"
                + "\"eventId\":\"e\",\"kind\":\"wake.requested\","
                + "\"occurredAt\":0,\"payloadRef\":{\"digest\":\""
                + "a".repeat(64) + "\"}}";
        return JSON.readTree(raw);
    }

    /**
     * The mirror's vocabulary and bounds pinned to the frozen fixtures, so a
     * Java-only drift of a constant goes red here and not only through the
     * cases that happen to exercise it.
     */
    @Test
    void theMirrorsConstantsAreTheFixtures() throws Exception {
        JsonNode fixtures = fixtures();
        assertEquals(ManagedEventEnvelopes.STREAMS,
                JSON.convertValue(fixtures.get("streams"), java.util.List.class));
        assertEquals(ManagedEventEnvelopes.KINDS,
                JSON.convertValue(fixtures.get("kinds"), java.util.List.class));
        assertEquals(ManagedEventEnvelopes.FORBIDDEN_FIELDS,
                java.util.Set.copyOf(JSON.convertValue(
                        fixtures.get("forbiddenFields"), java.util.List.class)));
        JsonNode limits = fixtures.get("limits");
        assertEquals(ManagedEventEnvelopes.MAX_ID_BYTES,
                limits.get("maxIdBytes").intValue());
        assertEquals(ManagedEventEnvelopes.MAX_JSON_DEPTH,
                limits.get("maxJsonDepth").intValue());
        assertEquals(ManagedEventEnvelopes.MAX_PUBLIC_KIND_BYTES,
                limits.get("maxPublicKindBytes").intValue());
        assertEquals(ManagedEventEnvelopes.MAX_TIME_MS,
                limits.get("maxTimeMs").longValue());
    }

    private static JsonNode fixtures() throws java.io.IOException {
        java.nio.file.Path directory = java.nio.file.Path.of("")
                .toAbsolutePath();
        while (directory != null) {
            java.nio.file.Path path = directory.resolve(
                    "packages/core/src/managed-runtime/contracts/managed-event-envelope-v1.fixtures.json");
            if (java.nio.file.Files.exists(path)) {
                return JSON.readTree(java.nio.file.Files.readString(path));
            }
            directory = directory.getParent();
        }
        throw new java.io.IOException("envelope contract fixtures not found");
    }
}
