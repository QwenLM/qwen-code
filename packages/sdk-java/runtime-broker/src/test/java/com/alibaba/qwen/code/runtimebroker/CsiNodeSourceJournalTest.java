package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertNull;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.function.Consumer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

class CsiNodeSourceJournalTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void consumesV3ProtocolFixtureWithoutChangingBodyOrder() throws Exception {
        Fixture fixture = fixture();
        assertEquals("ef8ff2ef7fe3456d08f45837c4258b92181674dc6a569fa79523e1fde2f84c6f",
                CsiNativeActivationProof.sha256(fixture.bytes()));
        var stream = CsiNodeSourceJournal.read(fixture.bytes(), fixture.head());
        assertEquals(fixture.head(), stream.head());
        assertEquals(1, stream.observations().size());
        var original = stream.observations().getFirst();
        assertEquals("UNPUBLISHED", original.state());
        assertEquals(2, original.arm().sequence());
        assertEquals(5, original.publish().sequence());
        assertEquals(8, original.stopped().sequence());
        assertEquals(10, original.unpublished().sequence());
    }

    @Test
    void validShortPrefixCannotReachIndependentlySavedHead() throws Exception {
        Fixture fixture = fixture();
        var frames = frames(fixture.bytes());
        byte[] prefix = encode(frames.subList(0, 5));
        assertThrows(IllegalArgumentException.class, () -> CsiNodeSourceJournal.read(prefix, fixture.head()));
        var shorter = new CsiNodeSourceJournal.Cursor(5, frames.get(4).path("hash").textValue());
        var observation = CsiNodeSourceJournal.read(prefix, shorter).observations().getFirst();
        assertEquals("PUBLISHED", observation.state());
        assertNull(observation.stopped());
        assertNull(observation.unpublished());
    }

    @Test
    void recordsEarlyIntentWithoutGrantingStopOrPublication() throws Exception {
        var original = frames(fixture().bytes());
        var frames = new ArrayList<>(original.subList(0, 3));
        ObjectNode intent = original.get(6);
        intent.put("sequence", 4);
        ((ObjectNode) intent.path("scope")).put("containerId", "");
        frames.add(intent);
        var head = rechain(frames);
        var observation = CsiNodeSourceJournal.read(encode(frames), head).observations().getFirst();
        assertEquals("STOP_INTENT", observation.state());
        assertNull(observation.publish());
        assertNull(observation.stopped());
        assertNull(observation.unpublished());
    }

    @ParameterizedTest
    @ValueSource(ints = {0, 1, 3, 4, 100, 8554})
    void rejectsTruncatedFraming(int length) throws Exception {
        Fixture fixture = fixture();
        assertThrows(IllegalArgumentException.class,
                () -> CsiNodeSourceJournal.read(Arrays.copyOf(fixture.bytes(), length), fixture.head()));
    }

    @Test
    void rejectsHashValidStopWithDifferentRetainedCgroup() throws Exception {
        rejects(7, r -> ((ObjectNode) r.path("custody")).put("cgroupInode", 999));
    }

    @ParameterizedTest
    @ValueSource(strings = {"changed-parent", "leaf-as-parent", "different-filesystem", "leaf-coverage", "missing-parent", "unknown"})
    void refusesHashValidInvalidParentCoverage(String fault) throws Exception {
        rejects(7, r -> {
            var custody = (ObjectNode) r.path("custody");
            switch (fault) {
                case "changed-parent" -> custody.put("parentInode", 999);
                case "leaf-as-parent" -> custody.set("parentInode", custody.path("cgroupInode"));
                case "different-filesystem" -> custody.put("parentDevice", 999);
                case "leaf-coverage" -> custody.put("coverage", "retained-leaf/1");
                case "missing-parent" -> custody.remove("parentInode");
                case "unknown" -> custody.put("qualified", true);
                default -> throw new AssertionError(fault);
            }
        });
    }

    @Test
    void rejectsHashValidChangedRuntimeImage() throws Exception {
        rejects(7, r -> ((ObjectNode) r.path("runtime")).put("imageDigest", "f".repeat(64)));
    }

    @Test
    void rejectsHashValidStopThatStillHasDescendants() throws Exception {
        rejects(7, r -> ((ObjectNode) r.path("custody")).put("populated", true));
    }

    @Test
    void rejectsHashValidDifferentUnpublishCaller() throws Exception {
        rejects(8, r -> ((ObjectNode) r.path("caller")).put("pid", 12345));
    }

    @Test
    void rejectsHashValidSubstitutedOriginalPod() throws Exception {
        rejects(9, r -> ((ObjectNode) r.path("scope")).put("podUid", "another-pod"));
    }

    @Test
    void rejectsHashValidWrongStopDependency() throws Exception {
        var f = fixture();
        var frames = frames(f.bytes());
        JsonNode publish = frames.get(4);
        rejects(8, r -> {
            ((ObjectNode) r.path("stop")).put("sequence", 5);
            ((ObjectNode) r.path("stop")).put("hash", publish.path("hash").textValue());
        });
    }

    @Test
    void rejectsNonExactFieldNameWithValidRehashedBody() throws Exception {
        rejects(9, r -> {
            JsonNode original = r.remove("kind");
            r.set("Kind", original);
        });
    }

    @Test
    void rejectsDuplicateFieldAndNonCanonicalWhitespace() throws Exception {
        Fixture fixture = fixture();
        var frames = frames(fixture.bytes());
        byte[] first = JSON.writeValueAsBytes(frames.getFirst());
        for (String raw : List.of(new String(first, StandardCharsets.UTF_8).replace("\"version\":", "\"version\":\"alias\",\"version\":"),
                " " + new String(first, StandardCharsets.UTF_8))) {
            var output = new ByteArrayOutputStream();
            byte[] changed = raw.getBytes(StandardCharsets.UTF_8);
            output.write(ByteBuffer.allocate(4).putInt(changed.length).array());
            output.write(changed);
            output.write(encode(frames.subList(1, frames.size())));
            assertThrows(IllegalArgumentException.class, () -> CsiNodeSourceJournal.read(output.toByteArray(), fixture.head()));
        }
    }

    @Test
    void decodesActualGoStringEscapesAndUnsignedKernelIdentity() throws Exception {
        var frames = frames(fixture().bytes());
        for (ObjectNode r : frames) {
            if (r.path("scope").isObject()) {
                ((ObjectNode) r.path("scope")).put("bindingId", "binding<>&\u2028\u2029\ud83d\ude00");
            }
            if (r.path("custody").isObject()) {
                ((ObjectNode) r.path("custody")).put("cgroupInode", new java.math.BigInteger("18446744073709551615"));
            }
        }
        var head = rechain(frames);
        var stream = CsiNodeSourceJournal.read(encode(frames), head);
        assertEquals("UNPUBLISHED", stream.observations().getFirst().state());
        assertEquals("binding<>&\u2028\u2029\ud83d\ude00", stream.observations().getFirst().scope().bindingId());
    }

    private static void rejects(int index, Consumer<ObjectNode> change) throws Exception {
        var frames = frames(fixture().bytes());
        change.accept(frames.get(index));
        // Recompute the entire chain and its cursor references, so failure is semantic rather than a stale hash.
        var head = rechain(frames);
        byte[] bytes = encode(frames);
        assertThrows(IllegalArgumentException.class, () -> CsiNodeSourceJournal.read(bytes, head));
    }

    @ParameterizedTest
    @ValueSource(strings = {"-1", "00", "9223372036854775808", "18446744073709551615"})
    void rejectsHashValidUnsupportedSignedPolicyRevision(String value) throws Exception {
        rejects(1, r -> ((ObjectNode) r.path("policy")).put("namespaceRevision", value));
    }

    @ParameterizedTest
    @ValueSource(strings = {"unlock", "complain", "source", "raw-link", "alias", "unknown", "abi", "future-load"})
    void rejectsHashValidUnsupportedPolicy(String changed) throws Exception {
        rejects(1, r -> {
            var policy = (ObjectNode) r.path("policy");
            switch (changed) {
                case "unlock" -> policy.put("lockPolicy", false);
                case "complain" -> policy.put("globalMode", "complain");
                case "source" -> policy.put("sourceLsmLabel", "unconfined");
                case "raw-link" -> policy.put("rawLink", "../../../raw_data/1/raw_data");
                case "alias" -> policy.set("RawSha256", policy.remove("rawSha256"));
                case "unknown" -> policy.put("qualified", true);
                case "abi" -> policy.put("rawAbi", "v10");
                case "future-load" -> policy.put("loadRevision", Long.toString(Long.MAX_VALUE));
                default -> throw new AssertionError(changed);
            }
        });
    }

    @Test
    void preservesSignedRevisionAndUnsignedPolicyIdentityLimits() throws Exception {
        var frames = frames(fixture().bytes());
        var policy = (ObjectNode) frames.get(1).path("policy");
        policy.put("namespaceRevision", Long.toString(Long.MAX_VALUE));
        ((ObjectNode) policy.path("rawObject")).put("inode", new java.math.BigInteger("18446744073709551615"));
        var head = rechain(frames);
        assertEquals("UNPUBLISHED", CsiNodeSourceJournal.read(encode(frames), head).observations().getFirst().state());
    }

    @Test
    void refusesTaskCustodyBeforeDurableOriginalPublication() throws Exception {
        var original = frames(fixture().bytes());
        var frames = new ArrayList<>(original.subList(0, 3));
        var early = original.get(5).deepCopy();
        early.put("sequence", 4);
        frames.add(early);
        var head = rechain(frames);
        assertThrows(IllegalArgumentException.class, () -> CsiNodeSourceJournal.read(encode(frames), head));
    }

    @Test
    void confinementLossBeforeBindPermanentlyBlocksTheOriginal() throws Exception {
        var frames = new ArrayList<>(frames(fixture().bytes()).subList(0, 2));
        var lost = frames.get(1).deepCopy();
        lost.put("kind", "CONFINEMENT_LOST").put("sequence", 3);
        lost.remove(List.of("imageDigest", "policy"));
        frames.add(lost);
        var head = rechain(frames);
        var observation = CsiNodeSourceJournal.read(encode(frames), head).observations().getFirst();
        assertEquals("BLOCKED", observation.state());
        assertNull(observation.bound());
        var next = lost.deepCopy();
        next.put("sequence", 4);
        frames.add(next);
        var invalidHead = rechain(frames);
        assertThrows(IllegalArgumentException.class, () -> CsiNodeSourceJournal.read(encode(frames), invalidHead));
    }

    @Test
    void historicalLeafFormatsCannotGrantParentCoverage() throws Exception {
        for (String version : List.of("v1", "v2")) {
            try (var input = getClass().getResourceAsStream("/contracts/k2-node-source-" + version + ".fixture.json")) {
                var value = JSON.readTree(input);
                byte[] bytes = Base64.getDecoder().decode(value.path("bytesBase64").textValue());
                var head = new CsiNodeSourceJournal.Cursor(value.path("head").path("sequence").longValue(), value.path("head").path("hash").textValue());
                assertThrows(IllegalArgumentException.class, () -> CsiNodeSourceJournal.read(bytes, head));
            }
        }
    }

    private static CsiNodeSourceJournal.Cursor rechain(List<ObjectNode> frames) throws Exception {
        var hashes = new HashMap<String, String>();
        String previous = "0".repeat(64);
        for (ObjectNode r : frames) {
            String oldHash = r.path("hash").textValue();
            r.put("previous", previous);
            for (String field : List.of("begin", "publish", "stop")) {
                if (r.path(field).isObject()) {
                    ObjectNode cursor = (ObjectNode) r.path(field);
                    String old = cursor.path("hash").textValue();
                    if (hashes.containsKey(old)) { cursor.put("hash", hashes.get(old)); }
                }
            }
            r.remove("hash");
            String hash = CsiNativeActivationProof.sha256(referenceGoBytes(r));
            r.put("hash", hash);
            hashes.put(oldHash, hash);
            previous = hash;
        }
        return new CsiNodeSourceJournal.Cursor(frames.size(), previous);
    }

    private static List<ObjectNode> frames(byte[] bytes) throws Exception {
        var input = ByteBuffer.wrap(bytes);
        var frames = new ArrayList<ObjectNode>();
        while (input.hasRemaining()) {
            byte[] raw = new byte[input.getInt()];
            input.get(raw);
            frames.add((ObjectNode) JSON.readTree(raw));
        }
        return frames;
    }

    private static byte[] encode(List<ObjectNode> frames) throws Exception {
        var output = new ByteArrayOutputStream();
        for (ObjectNode frame : frames) {
            byte[] raw = referenceGoBytes(frame);
            output.write(ByteBuffer.allocate(4).putInt(raw.length).array());
            output.write(raw);
        }
        return output.toByteArray();
    }

    private static byte[] referenceGoBytes(JsonNode frame) throws Exception {
        return JSON.writeValueAsString(frame).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
                .replace("\u2028", "\\u2028").replace("\u2029", "\\u2029").getBytes(StandardCharsets.UTF_8);
    }

    private static Fixture fixture() throws Exception {
        try (var input = CsiNodeSourceJournalTest.class.getResourceAsStream("/contracts/k2-node-source-v3.fixture.json")) {
            JsonNode value = JSON.readTree(input);
            return new Fixture(Base64.getDecoder().decode(value.path("bytesBase64").textValue()),
                    new CsiNodeSourceJournal.Cursor(value.path("head").path("sequence").longValue(),
                            value.path("head").path("hash").textValue()));
        }
    }

    private record Fixture(byte[] bytes, CsiNodeSourceJournal.Cursor head) {
    }
}
