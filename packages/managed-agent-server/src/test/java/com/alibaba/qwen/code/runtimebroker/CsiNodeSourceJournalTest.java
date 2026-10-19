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
import java.util.function.UnaryOperator;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

class CsiNodeSourceJournalTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void consumesSyntheticV7BytesAndFrontendWithoutChangingBodyOrder() throws Exception {
        Fixture fixture = fixture();
        assertEquals("a27fd1b05b3a25a03e342b25bd9a3bca20d3fa7791941bbc971d16b7282f38f9",
                CsiNativeActivationProof.sha256(fixture.bytes()));
        var stream = CsiNodeSourceJournal.read(fixture.bytes(), fixture.head());
        assertEquals(fixture.head(), stream.head());
        assertEquals(1, stream.observations().size());
        var original = stream.observations().getFirst();
        assertEquals("UNPUBLISHED", original.state());
        assertEquals(2, original.arm().sequence());
        assertEquals(5, original.publish().sequence());
        assertEquals(16, original.stopped().sequence());
        assertEquals(18, original.unpublished().sequence());
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

    @ParameterizedTest
    @ValueSource(ints = {5, 6, 7, 8, 9, 10, 11, 12, 13, 18})
    void exportsOnlyActualVerifiedBirthCursorsAtTheReadHead(int sequence) throws Exception {
        var records = frames(fixture().bytes()).subList(0, sequence);
        var evidence = CsiNodeSourceJournal.verify(encode(records),
                new CsiNodeSourceJournal.Cursor(sequence, records.getLast().path("hash").textValue()));
        var observed = evidence.stream().observations().getFirst();
        assertEquals(sequence < 6 ? 0 : sequence < 10 ? 1 : 2, observed.births().size());
        assertThrows(UnsupportedOperationException.class, () -> observed.births().clear());
        for (var born : observed.births()) {
            var actual = evidence.record(born.prepared()).path("birth");
            assertEquals(actual.path("role").textValue(), born.role());
            assertEquals(actual.path("id").textValue(), born.containerId());
            assertEquals(actual.path("sandboxId").textValue(), born.sandboxId());
            assertEquals(actual.path("imageRootfs").path("manifestSha256").textValue(), born.imageDigest());
            long prepared = "sandbox".equals(born.role()) ? 6 : 10;
            assertEquals(prepared, born.prepared().sequence());
            for (var step : List.of("created", "startBegin", "started")) {
                var cursor = switch (step) {
                    case "created" -> born.created();
                    case "startBegin" -> born.startBegin();
                    default -> born.started();
                };
                int offset = "created".equals(step) ? 1 : "startBegin".equals(step) ? 2 : 3;
                if (prepared + offset > sequence) {
                    assertNull(cursor);
                } else {
                    assertEquals(prepared + offset, cursor.sequence());
                    assertEquals(born.containerId(), evidence.record(cursor).path("birth").path("id").textValue());
                    assertEquals(born.prepared().hash(), evidence.record(cursor).path("birth").path("prepared").path("hash").textValue());
                }
            }
            assertNull(born.deleted());
        }
        if (sequence >= 13) {
            var sandbox = observed.births().getFirst();
            var worker = observed.births().getLast();
            assertEquals(sandbox.containerId(), worker.sandboxId());
            assertEquals(observed.scope().containerId(), worker.containerId());
            assertEquals("sandbox", sandbox.role());
            assertEquals("container", worker.role());
        }
    }

    @Test
    void recordsEarlyIntentWithoutGrantingStopOrPublication() throws Exception {
        var original = frames(fixture().bytes());
        var frames = new ArrayList<>(original.subList(0, 3));
        ObjectNode intent = original.get(14);
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

    @ParameterizedTest
    @ValueSource(ints = {8, 9})
    void rejectsHashValidUnpublishWithoutFreshCustody(int index) throws Exception {
        rejects(index, r -> r.remove(List.of("custody", "runtime")));
    }

    @ParameterizedTest
    @ValueSource(ints = {8, 9})
    void rejectsHashValidUnpublishWithLiveDescendant(int index) throws Exception {
        rejects(index, r -> ((ObjectNode) r.path("custody")).put("populated", true));
    }

    @ParameterizedTest
    @ValueSource(ints = {8, 9})
    void rejectsHashValidUnpublishWithChangedTerminalIdentity(int index) throws Exception {
        rejects(index, r -> ((ObjectNode) r.path("custody")).put("parentInode", 999));
        rejects(index, r -> ((ObjectNode) r.path("custody")).put("terminal", false));
        rejects(index, r -> ((ObjectNode) r.path("runtime")).put("exitedAtNano", 999));
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
            if (r.path("birth").path("custody").isObject() && "container".equals(r.path("birth").path("role").asText())) {
                ((ObjectNode) r.path("birth").path("custody")).put("cgroupInode", new java.math.BigInteger("18446744073709551615"));
            }
        }
        var head = rechain(frames);
        var stream = CsiNodeSourceJournal.read(encode(frames), head);
        assertEquals("UNPUBLISHED", stream.observations().getFirst().state());
        assertEquals("binding<>&\u2028\u2029\ud83d\ude00", stream.observations().getFirst().scope().bindingId());
    }

    private static void rejects(int index, Consumer<ObjectNode> change) throws Exception {
        var frames = frames(fixture().bytes());
        change.accept(frames.get(index >= 5 ? index + 8 : index));
        // Recompute the entire chain and its cursor references, so failure is semantic rather than a stale hash.
        var head = rechain(frames);
        byte[] bytes = encode(frames);
        assertThrows(IllegalArgumentException.class, () -> CsiNodeSourceJournal.read(bytes, head));
    }

    @ParameterizedTest
    @ValueSource(strings = {"input-bytes", "writable", "unsealed", "source-peer", "created-dependency", "start-dependency", "namespace-parent", "unknown"})
    void rejectsRehashedChangedBirthInputsAndDependencies(String fault) throws Exception {
        var frames = frames(fixture().bytes());
        int index = switch (fault) {
            case "created-dependency" -> 11;
            case "start-dependency" -> 12;
            case "namespace-parent" -> 10;
            default -> 9;
        };
        var b = (ObjectNode) frames.get(index).path("birth");
        switch (fault) {
            case "input-bytes" -> b.put("originalSpec", Base64.getEncoder().encodeToString("{}".getBytes(StandardCharsets.UTF_8)));
            case "writable" -> ((ObjectNode) b.path("objects").get(0)).put("mode", 0100600);
            case "unsealed" -> ((ObjectNode) b.path("objects").get(0)).put("flags", 0);
            case "source-peer" -> ((ObjectNode) b.path("peer")).put("pid", 9981);
            case "created-dependency" -> b.set("created", b.path("prepared").deepCopy());
            case "start-dependency" -> b.set("startBegin", b.path("created").deepCopy());
            case "namespace-parent" -> ((com.fasterxml.jackson.databind.node.ArrayNode) b.path("namespaces").path("namespaces"))
                    .set(0, frames.get(6).path("birth").path("namespaces").path("namespaces").get(0).deepCopy());
            case "unknown" -> b.put("qualified", true);
            default -> throw new AssertionError(fault);
        }
        var head = rechain(frames);
        assertThrows(IllegalArgumentException.class, () -> CsiNodeSourceJournal.read(encode(frames), head));
    }

    @ParameterizedTest
    @ValueSource(strings = {"-1", "00", "9223372036854775808", "18446744073709551615"})
    void rejectsHashValidUnsupportedSignedPolicyRevision(String value) throws Exception {
        rejects(1, r -> ((ObjectNode) r.path("policy")).put("namespaceRevision", value));
    }

    @Test
    void refusesStringReadonlyEvenWithConsistentOriginalInputsAndSourceHashes() throws Exception {
        var frames = frames(fixture().bytes());
        for (ObjectNode frame : frames) {
            var birth = frame.path("birth");
            if ("container".equals(birth.path("role").textValue())) {
                for (String field : List.of("originalSpec", "consumedSpec")) {
                    var spec = (ObjectNode) JSON.readTree(Base64.getDecoder().decode(birth.path(field).textValue()));
                    ((ObjectNode) spec.path("root")).put("readonly", "true");
                    replaceBirthInput((ObjectNode) birth, field, field.equals("originalSpec") ? 3 : 0,
                            JSON.writeValueAsBytes(spec));
                }
            }
        }
        var head = rechain(frames);
        assertThrows(IllegalArgumentException.class, () -> CsiNodeSourceJournal.read(encode(frames), head));
    }

    @Test
    void rejectsOutOfRangeProtobufTagWithTheProtocolException() throws Exception {
        var frames = frames(fixture().bytes());
        for (ObjectNode frame : frames) {
            if ("container".equals(frame.path("birth").path("role").textValue())) {
                var birth = (ObjectNode) frame.path("birth");
                var raw = new ByteArrayOutputStream();
                raw.write(Base64.getDecoder().decode(birth.path("originalRequest").textValue()));
                long tag = ((long) Integer.MAX_VALUE + 1) << 3 | 2;
                while (tag >= 128) {
                    raw.write((int) (tag & 127) | 128);
                    tag >>>= 7;
                }
                raw.write((int) tag);
                raw.write(0);
                replaceBirthInput(birth, "originalRequest", 1, raw.toByteArray());
            }
        }
        var head = rechain(frames);
        assertThrows(IllegalArgumentException.class, () -> CsiNodeSourceJournal.read(encode(frames), head));
    }

    private static void replaceBirthInput(ObjectNode birth, String field, int index, byte[] raw) {
        birth.put(field, Base64.getEncoder().encodeToString(raw));
        var measured = (ObjectNode) birth.path("objects").get(index);
        measured.put("bytes", raw.length);
        measured.put("sha256", CsiNativeActivationProof.sha256(raw));
    }

    @ParameterizedTest
    @ValueSource(strings = {"privileges", "profile", "capability", "group", "username", "inherited-mount", "time-namespace",
            "missing-namespace", "user-mapping", "allow-seccomp", "terminal", "foreign-os"})
    void rejectsConsistentlyRehashedWorkerSecurityChanges(String fault) throws Exception {
        var records = frames(fixture().bytes());
        for (ObjectNode record : records) {
            if (!"container".equals(record.path("birth").path("role").textValue())) {
                continue;
            }
            var born = (ObjectNode) record.path("birth");
            for (String field : List.of("originalSpec", "consumedSpec")) {
                var spec = (ObjectNode) JSON.readTree(Base64.getDecoder().decode(born.path(field).textValue()));
                var process = (ObjectNode) spec.path("process");
                var linux = (ObjectNode) spec.path("linux");
                var user = (ObjectNode) process.path("user");
                var namespaces = (com.fasterxml.jackson.databind.node.ArrayNode) linux.path("namespaces");
                switch (fault) {
                    case "privileges" -> process.put("noNewPrivileges", false);
                    case "profile" -> process.put("apparmorProfile", "unconfined");
                    case "capability" -> ((ObjectNode) process.path("capabilities")).putArray("bounding").add("CAP_SYS_ADMIN");
                    case "group" -> user.putArray("additionalGids").add(0);
                    case "username" -> user.put("username", "root");
                    case "inherited-mount" -> {
                        for (JsonNode namespace : namespaces) {
                            if (namespace.path("type").asText().equals("mount")) {
                                ((ObjectNode) namespace).put("path", "/proc/1/ns/mnt");
                            }
                        }
                    }
                    case "time-namespace" -> namespaces.addObject().put("type", "time");
                    case "missing-namespace" -> namespaces.remove(0);
                    case "user-mapping" -> linux.putArray("uidMappings").addObject().put("containerID", 0).put("hostID", 0).put("size", 1);
                    case "allow-seccomp" -> ((ObjectNode) linux.path("seccomp")).put("defaultAction", "SCMP_ACT_ALLOW");
                    case "terminal" -> process.put("terminal", true);
                    case "foreign-os" -> spec.putObject("windows");
                    default -> throw new AssertionError(fault);
                }
                replaceBirthInput(born, field, field.equals("originalSpec") ? 3 : 0, JSON.writeValueAsBytes(spec));
            }
        }
        var head = rechain(records);
        assertThrows(IllegalArgumentException.class, () -> CsiNodeSourceJournal.verify(encode(records), head));
    }

    @ParameterizedTest
    @ValueSource(strings = {"worker-network", "worker-ipc", "worker-uts", "sandbox-network", "sandbox-privileges",
            "sandbox-capabilities", "sandbox-unknown-capability", "sandbox-capability-element"})
    void rejectsOriginalOciSecurityFieldsThatTheTypedProducerCannotDecode(String fault) throws Exception {
        var records = frames(fixture().bytes());
        boolean sandbox = fault.startsWith("sandbox-");
        for (ObjectNode record : records) {
            if (!(sandbox ? "sandbox" : "container").equals(record.path("birth").path("role").textValue())) {
                continue;
            }
            var born = (ObjectNode) record.path("birth");
            for (String field : List.of("originalSpec", "consumedSpec")) {
                if (sandbox && !fault.equals("sandbox-network") && field.equals("consumedSpec")) {
                    continue;
                }
                var spec = (ObjectNode) JSON.readTree(Base64.getDecoder().decode(born.path(field).textValue()));
                var process = (ObjectNode) spec.path("process");
                switch (fault) {
                    case "sandbox-privileges" -> process.put("noNewPrivileges", "false");
                    case "sandbox-capabilities" -> process.put("capabilities", 1);
                    case "sandbox-unknown-capability" -> process.putObject("capabilities").putArray("unknown");
                    case "sandbox-capability-element" -> process.putObject("capabilities").putArray("bounding").add(1);
                    default -> {
                        String kind = fault.substring(fault.indexOf('-') + 1);
                        for (JsonNode namespace : spec.path("linux").path("namespaces")) {
                            if (namespace.path("type").asText().equals(kind)) {
                                ((ObjectNode) namespace).put("path", 1);
                            }
                        }
                    }
                }
                replaceBirthInput(born, field, field.equals("originalSpec") ? 3 : 0, JSON.writeValueAsBytes(spec));
            }
        }
        var head = rechain(records);
        assertThrows(IllegalArgumentException.class, () -> CsiNodeSourceJournal.verify(encode(records), head));
    }

    @ParameterizedTest
    @ValueSource(strings = {"type", "source", "target", "unknown", "options"})
    void rejectsConsistentUnsupportedNestedRootfsMounts(String fault) throws Exception {
        var records = frames(fixture().bytes());
        for (ObjectNode record : records) {
            if (!record.has("birth")) {
                continue;
            }
            var born = (ObjectNode) record.path("birth");
            for (String field : List.of("originalRequest", "consumedRequest")) {
                byte[] changed = replaceBytesField(Base64.getDecoder().decode(born.path(field).textValue()), 3, mount -> {
                    try {
                        return switch (fault) {
                            case "type" -> replaceBytesField(mount, 1, unused -> new byte[0]);
                            case "source" -> replaceBytesField(mount, 2, unused -> new byte[0]);
                            case "target" -> protobufString(mount, 3, "/unexpected-target");
                            case "unknown" -> protobufString(mount, 5, "unsupported");
                            case "options" -> {
                                byte[] extended = mount;
                                for (int index = 0; index < 65; index++) {
                                    extended = protobufString(extended, 4, "ro");
                                }
                                yield extended;
                            }
                            default -> throw new AssertionError(fault);
                        };
                    } catch (Exception failure) {
                        throw new AssertionError(failure);
                    }
                });
                replaceBirthInput(born, field, field.equals("originalRequest") ? 1 : 2, changed);
            }
        }
        var head = rechain(records);
        assertThrows(IllegalArgumentException.class, () -> CsiNodeSourceJournal.verify(encode(records), head));
    }

    @ParameterizedTest
    @ValueSource(strings = {"0800", "1000", "1a00", "2000", "2800", "5200", "5a00", "6200", "6800"})
    void preservesDeclaredDefaultRuncOptionsWithoutRewritingOriginalBytes(String value) throws Exception {
        var records = withRuncOption(java.util.HexFormat.of().parseHex(value));
        var head = rechain(records);
        var evidence = CsiNodeSourceJournal.verify(encode(records), head);
        assertEquals("UNPUBLISHED", evidence.stream().observations().getFirst().state());
        for (var born : evidence.stream().observations().getFirst().births()) {
            assertEquals(records.get((int) born.prepared().sequence() - 1), evidence.record(born.prepared()));
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"0801", "1001", "1a0178", "2001", "2801", "520178", "5a0178", "620178", "6801", "4000", "f80700", "0a00", "1800"})
    void refusesNonDefaultReservedUnknownAndWrongTypeRuncOptions(String value) throws Exception {
        var records = withRuncOption(java.util.HexFormat.of().parseHex(value));
        var head = rechain(records);
        assertThrows(IllegalArgumentException.class, () -> CsiNodeSourceJournal.verify(encode(records), head));
    }

    private static List<ObjectNode> withRuncOption(byte[] option) throws Exception {
        var records = frames(fixture().bytes());
        for (ObjectNode record : records) {
            if (record.has("birth")) {
                var born = (ObjectNode) record.path("birth");
                for (String field : List.of("originalRequest", "consumedRequest")) {
                    byte[] request = Base64.getDecoder().decode(born.path(field).textValue());
                    byte[] changed = replaceBytesField(request, 10,
                            any -> replaceBytesField(any, 2, options -> {
                                byte[] extended = Arrays.copyOf(options, options.length + option.length);
                                System.arraycopy(option, 0, extended, options.length, option.length);
                                return extended;
                            }));
                    replaceBirthInput(born, field, field.equals("originalRequest") ? 1 : 2, changed);
                }
            }
        }
        return records;
    }

    private static byte[] replaceBytesField(byte[] raw, int field, UnaryOperator<byte[]> change) {
        var input = ByteBuffer.wrap(raw);
        var output = new ByteArrayOutputStream();
        boolean changed = false;
        while (input.hasRemaining()) {
            int start = input.position(), tag = input.get() & 0xff;
            assertEquals(2, tag & 7);
            int length = 0, shift = 0, next;
            do {
                next = input.get() & 0xff;
                length |= (next & 127) << shift;
                shift += 7;
            } while (next >= 128);
            byte[] value = new byte[length];
            input.get(value);
            if (tag >>> 3 != field) {
                output.write(raw, start, input.position() - start);
                continue;
            }
            value = change.apply(value);
            output.write(tag);
            int size = value.length;
            while (size >= 128) {
                output.write(size & 127 | 128);
                size >>>= 7;
            }
            output.write(size);
            output.writeBytes(value);
            changed = true;
        }
        assertEquals(true, changed);
        return output.toByteArray();
    }

    @ParameterizedTest
    @ValueSource(strings = {"binary", "binary-v2", "file", "foreign", "relative", "stdin", "stderr"})
    void refusesOriginalRequestIOThatCouldLaunchHelpersOrWriteOtherPaths(String fault) throws Exception {
        var frames = frames(fixture().bytes());
        for (ObjectNode frame : frames) {
            if ("container".equals(frame.path("birth").path("role").textValue())) {
                var birth = (ObjectNode) frame.path("birth");
                String value = switch (fault) {
                    case "binary", "binary-v2", "file" -> fault + ":///unrelated";
                    case "relative" -> "relative-output";
                    default -> "/unrelated/output";
                };
                int number = fault.equals("stdin") ? 5 : fault.equals("stderr") ? 7 : 6;
                for (String field : List.of("originalRequest", "consumedRequest")) {
                    byte[] raw = protobufString(Base64.getDecoder().decode(birth.path(field).textValue()), number, value);
                    replaceBirthInput(birth, field, field.equals("originalRequest") ? 1 : 2, raw);
                }
            }
        }
        var head = rechain(frames);
        assertThrows(IllegalArgumentException.class, () -> CsiNodeSourceJournal.read(encode(frames), head));
    }

    @Test
    void acceptsDeclaredOriginalFIFOPathsWithoutRewritingTheEvidence() throws Exception {
        var frames = frames(fixture().bytes());
        for (ObjectNode frame : frames) {
            if ("container".equals(frame.path("birth").path("role").textValue())) {
                var birth = (ObjectNode) frame.path("birth");
                String id = birth.path("id").textValue();
                String root = "/run/containerd/io.containerd.grpc.v1.cri/containers/" + id + "/io/123456789/";
                for (String field : List.of("originalRequest", "consumedRequest")) {
                    byte[] raw = Base64.getDecoder().decode(birth.path(field).textValue());
                    raw = protobufString(raw, 6, root + id + "-stdout");
                    raw = protobufString(raw, 7, root + id + "-stderr");
                    replaceBirthInput(birth, field, field.equals("originalRequest") ? 1 : 2, raw);
                }
            }
        }
        var head = rechain(frames);
        assertEquals("UNPUBLISHED", CsiNodeSourceJournal.read(encode(frames), head).observations().getFirst().state());
    }

    private static byte[] protobufString(byte[] original, int field, String value) throws Exception {
        var raw = new ByteArrayOutputStream();
        raw.write(original);
        raw.write(field << 3 | 2);
        byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
        int size = bytes.length;
        while (size >= 128) {
            raw.write(size & 127 | 128);
            size >>>= 7;
        }
        raw.write(size);
        raw.write(bytes);
        return raw.toByteArray();
    }

    @ParameterizedTest
    @ValueSource(strings = {"active-parent", "committed-kind", "missing-parent", "manifest-bytes", "config-bytes", "foreign-diff-ids", "unreviewed-snapshotter", "unknown"})
    void rejectsHashValidImageAndSnapshotChangesAcrossTheWholeWorkerBirth(String fault) throws Exception {
        var frames = frames(fixture().bytes());
        for (ObjectNode frame : frames) {
            if ("container".equals(frame.path("birth").path("role").textValue())) {
                var proof = (ObjectNode) frame.path("birth").path("imageRootfs");
                var snapshots = (com.fasterxml.jackson.databind.node.ArrayNode) proof.path("snapshots");
                switch (fault) {
                    case "active-parent" -> ((ObjectNode) snapshots.get(0)).put("parent", snapshots.get(2).path("name").textValue());
                    case "committed-kind" -> ((ObjectNode) snapshots.get(1)).put("kind", 2);
                    case "missing-parent" -> snapshots.remove(2);
                    case "manifest-bytes" -> proof.put("manifest", Base64.getEncoder().encodeToString(
                            (new String(Base64.getDecoder().decode(proof.path("manifest").textValue()), StandardCharsets.UTF_8) + " ")
                                    .getBytes(StandardCharsets.UTF_8)));
                    case "config-bytes" -> proof.put("configuration", Base64.getEncoder().encodeToString(
                            (new String(Base64.getDecoder().decode(proof.path("configuration").textValue()), StandardCharsets.UTF_8) + " ")
                                    .getBytes(StandardCharsets.UTF_8)));
                    case "foreign-diff-ids" -> {
                        var config = (ObjectNode) JSON.readTree(Base64.getDecoder().decode(proof.path("configuration").textValue()));
                        ((com.fasterxml.jackson.databind.node.ArrayNode) config.path("rootfs").path("diff_ids"))
                                .set(1, JSON.getNodeFactory().textNode("sha256:" + "e".repeat(64)));
                        byte[] configRaw = JSON.writeValueAsBytes(config);
                        var manifest = (ObjectNode) JSON.readTree(Base64.getDecoder().decode(proof.path("manifest").textValue()));
                        ((ObjectNode) manifest.path("config")).put("digest", "sha256:" + CsiNativeActivationProof.sha256(configRaw));
                        ((ObjectNode) manifest.path("config")).put("size", configRaw.length);
                        byte[] manifestRaw = JSON.writeValueAsBytes(manifest);
                        proof.put("manifest", Base64.getEncoder().encodeToString(manifestRaw));
                        proof.put("configuration", Base64.getEncoder().encodeToString(configRaw));
                        proof.put("manifestSha256", CsiNativeActivationProof.sha256(manifestRaw));
                    }
                    case "unreviewed-snapshotter" -> proof.put("snapshotter", "unknown");
                    case "unknown" -> proof.put("qualified", true);
                    default -> throw new AssertionError(fault);
                }
            }
        }
        if (fault.equals("foreign-diff-ids")) {
            String image = frames.get(9).path("birth").path("imageRootfs").path("manifestSha256").textValue();
            frames.get(1).put("imageDigest", image);
            for (ObjectNode frame : frames) {
                if (frame.has("runtime")) {
                    ((ObjectNode) frame.path("runtime")).put("imageDigest", image);
                }
            }
        }
        var head = rechain(frames);
        assertThrows(IllegalArgumentException.class, () -> CsiNodeSourceJournal.read(encode(frames), head));
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
        var early = original.get(13).deepCopy();
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
        lost.remove(List.of("imageDigest", "policy", "frontend"));
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
        for (String version : List.of("v1", "v2", "v3", "v4")) {
            try (var input = getClass().getResourceAsStream("/contracts/k2-node-source-" + version + ".fixture.json")) {
                var value = JSON.readTree(input);
                byte[] bytes = Base64.getDecoder().decode(value.path("bytesBase64").textValue());
                var head = new CsiNodeSourceJournal.Cursor(value.path("head").path("sequence").longValue(), value.path("head").path("hash").textValue());
                assertThrows(IllegalArgumentException.class, () -> CsiNodeSourceJournal.read(bytes, head));
            }
        }
    }

    @Test
    void sourceSixCannotAcquireInstalledBytesByDefault() throws Exception {
        try (var input = getClass().getResourceAsStream("/contracts/k2-node-source-v6.fixture.json")) {
            var old = JSON.readTree(input);
            byte[] raw = Base64.getDecoder().decode(old.path("bytesBase64").textValue());
            var head = new CsiNodeSourceJournal.Cursor(old.path("head").path("sequence").longValue(), old.path("head").path("hash").textValue());
            assertThrows(IllegalArgumentException.class, () -> CsiNodeSourceJournal.read(raw, head));
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"format", "role", "installationSha256", "architecture", "packedSha256", "packedBytes",
        "configurationPath", "configurationSha256", "shimConfigurationSha256", "unitPath", "unitSha256"})
    void installedObservationFieldsAreMandatoryAndNotNullable(String field) throws Exception {
        for (String role : List.of("sourceArtifacts", "gatewayArtifacts")) {
            rejects(0, r -> ((ObjectNode) r.path("source").path(role)).remove(field));
            rejects(0, r -> ((ObjectNode) r.path("source").path(role)).putNull(field));
        }
    }

    @Test
    void installedObservationsRejectUnknownAndForeignRoleData() throws Exception {
        rejects(0, r -> ((ObjectNode) r.path("source").path("sourceArtifacts")).put("qualified", true));
        rejects(0, r -> ((ObjectNode) r.path("source").path("gatewayArtifacts")).put("role", "source"));
        rejects(0, r -> ((ObjectNode) r.path("source").path("gatewayArtifacts")).put("installationSha256", "f".repeat(64)));
        rejects(1, r -> ((ObjectNode) r.path("frontend")).remove("registrar"));
        rejects(1, r -> ((ObjectNode) r.path("frontend")).put("qualified", true));
    }

    @Test
    void bothConsistentLaterCallersCannotReplaceTheOriginalArmKubelet() throws Exception {
        var frames = frames(fixture().bytes());
        for (ObjectNode frame : frames) {
            if (frame.has("caller")) {
                ((ObjectNode) frame.path("caller")).put("pid", 4348);
            }
        }
        var head = rechain(frames);
        assertThrows(IllegalArgumentException.class, () -> CsiNodeSourceJournal.read(encode(frames), head));
    }

    @Test
    void aWellFormedBytePairStillMustMatchTheActualArmPolicyLength() throws Exception {
        var frames = frames(fixture().bytes());
        for (String role : List.of("sourceArtifacts", "gatewayArtifacts")) {
            ((ObjectNode) frames.getFirst().path("source").path(role)).put("packedBytes", 2);
        }
        var head = rechain(frames);
        assertThrows(IllegalArgumentException.class, () -> CsiNodeSourceJournal.read(encode(frames), head));
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
            if (r.path("birth").isObject()) {
                for (String field : List.of("prepared", "created", "startBegin")) {
                    if (r.path("birth").path(field).isObject()) {
                        ObjectNode cursor = (ObjectNode) r.path("birth").path(field);
                        String replacement = hashes.get(cursor.path("hash").textValue());
                        if (replacement != null) { cursor.put("hash", replacement); }
                    }
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
        try (var input = CsiNodeSourceJournalTest.class.getResourceAsStream("/contracts/k2-node-source-v7.fixture.json")) {
            JsonNode value = JSON.readTree(input);
            return new Fixture(Base64.getDecoder().decode(value.path("bytesBase64").textValue()),
                    new CsiNodeSourceJournal.Cursor(value.path("head").path("sequence").longValue(),
                            value.path("head").path("hash").textValue()));
        }
    }

    private record Fixture(byte[] bytes, CsiNodeSourceJournal.Cursor head) {
    }
}
