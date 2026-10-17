package com.alibaba.qwen.code.runtimebroker;

import com.fasterxml.jackson.core.JsonFactory;
import com.fasterxml.jackson.core.StreamReadConstraints;
import com.fasterxml.jackson.core.StreamReadFeature;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Verifies source bytes and explicit dependencies; observations do not authorize physical release. */
public final class CsiNodeSourceJournal {
    public static final int MAX_BYTES = 64 * 1024 * 1024;
    private static final int MAX_RECORD_BYTES = 192 * 1024;
    public static final int RESPONSE_LIMIT = ((MAX_BYTES + 2) / 3) * 4 + 1024;
    private static final BigInteger UINT64 = BigInteger.ONE.shiftLeft(64).subtract(BigInteger.ONE);
    private static final ObjectMapper JSON = new ObjectMapper(JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .streamReadConstraints(StreamReadConstraints.builder().maxNestingDepth(16)
                    .maxStringLength(RESPONSE_LIMIT).maxNumberLength(20).build()).build())
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);
    private static final List<String> SCOPE = List.of("armId", "namespace", "podName", "podUid", "containerId", "driver",
            "volumeId", "pvUid", "pvcUid", "target", "bindingId", "retirementId");
    private static final List<String> RECORD = List.of("version", "incarnation", "sequence", "previous", "kind", "source",
            "scope", "begin", "publish", "stop", "custody", "runtime", "caller", "target", "intentHash", "status",
            "imageDigest", "policy", "frontend", "gatedSpecSha256", "podResourceVersion", "birth", "hash");

    private CsiNodeSourceJournal() {}

    public record Cursor(long sequence, String hash) {
        public Cursor {
            require(sequence > 0 && sequence <= 65536 && hash != null && hash.matches("[0-9a-f]{64}"));
        }
    }

    public record SourceIdentity(String nodeUid, String bootId, String runtimeDigest, BigInteger runtimeStart,
            int runtimePid, String gatewayIncarnation, String pluginDigest, BigInteger pluginStart, int pluginPid,
            CsiInstalledByteObservation sourceArtifacts, CsiInstalledByteObservation gatewayArtifacts) {}

    public record Scope(String armId, String namespace, String podName, String podUid, String containerId, String driver,
            String volumeId, String pvUid, String pvcUid, String target, String bindingId, String retirementId) {}

    /** Read-only projections of verified birth records, never deployment or release permissions. */
    public record BirthObservation(String role, String containerId, String sandboxId, String imageDigest,
            Cursor prepared, Cursor created, Cursor startBegin, Cursor started, Cursor deleted) {}

    public record Observation(Scope scope, String state, Cursor arm, Cursor bound, Cursor custody,
            Cursor publish, Cursor intent, Cursor stopped, Cursor unpublished, List<BirthObservation> births) {
        public Observation {
            births = List.copyOf(births);
        }
    }

    public record Stream(String incarnation, SourceIdentity source, Cursor head, String bytesSha256, List<Observation> observations) {
        public Stream {
            observations = List.copyOf(observations);
        }
    }

    public static final class Evidence {
        private final byte[] bytes;
        private final Stream stream;

        private Evidence(byte[] bytes, Cursor head) {
            this.bytes = bytes.clone();
            this.stream = read(this.bytes, head);
        }

        public byte[] bytes() {
            return bytes.clone();
        }
        public Stream stream() {
            return stream;
        }

        public void requireExtends(Evidence previous) {
            require(previous != null && stream.incarnation().equals(previous.stream.incarnation())
                    && stream.source().equals(previous.stream.source()) && bytes.length >= previous.bytes.length
                    && Arrays.equals(bytes, 0, previous.bytes.length, previous.bytes, 0, previous.bytes.length));
        }

        public JsonNode record(Cursor cursor) {
            require(cursor != null && cursor.sequence() <= stream.head().sequence());
            var input = ByteBuffer.wrap(bytes);
            for (long sequence = 1; sequence <= cursor.sequence(); sequence++) {
                int size = input.getInt();
                if (sequence == cursor.sequence()) {
                    byte[] raw = new byte[size];
                    input.get(raw);
                    var record = object(raw, MAX_RECORD_BYTES);
                    require(cursor.hash().equals(text(record, "hash")));
                    return record;
                }
                input.position(input.position() + size);
            }
            throw new IllegalArgumentException("Original source cursor is unavailable");
        }
    }

    public static Evidence verify(byte[] bytes, Cursor head) {
        return new Evidence(bytes, head);
    }

    public static Stream read(byte[] bytes, Cursor head) {
        require(bytes != null && bytes.length > 0 && bytes.length <= MAX_BYTES && head != null);
        var input = ByteBuffer.wrap(bytes);
        String previous = "0".repeat(64);
        String incarnation = null;
        var records = new ArrayList<JsonNode>();
        var originals = new LinkedHashMap<String, Original>();
        Original active = null;
        while (input.hasRemaining()) {
            require(input.remaining() >= 4 && records.size() < 65536);
            int size = input.getInt();
            require(size > 0 && size <= MAX_RECORD_BYTES && input.remaining() >= size);
            byte[] raw = new byte[size];
            input.get(raw);
            JsonNode record = object(raw, MAX_RECORD_BYTES);
            validate(record);
            require(integer(record, "sequence", 65536) == records.size() + 1L
                    && previous.equals(text(record, "previous")));
            if (incarnation == null) {
                incarnation = text(record, "incarnation");
            }
            require(incarnation.equals(text(record, "incarnation")));
            // Go hashes its ordered, HTML-escaped body, excluding the final hash field.
            String suffix = ",\"hash\":\"" + text(record, "hash") + "\"}";
            byte[] canonical = goJson(record).getBytes(StandardCharsets.UTF_8);
            require(Arrays.equals(raw, canonical));
            int bodySize = raw.length - suffix.getBytes(StandardCharsets.UTF_8).length;
            require(bodySize > 0);
            byte[] body = Arrays.copyOf(raw, bodySize + 1);
            body[bodySize] = '}';
            require(CsiNativeActivationProof.sha256(body).equals(text(record, "hash")));
            String kind = text(record, "kind");
            if (!"SOURCE_START".equals(kind)) {
                JsonNode scope = record.path("scope");
                String armId = text(scope, "armId");
                Original original = originals.get(armId);
                if ("ARM".equals(kind)) {
                    require(original == null && originals.size() < 4096 && (active == null || active.unpublished != null));
                    var installed = CsiInstalledByteObservation.read(records.getFirst().path("source").path("sourceArtifacts"));
                    require(installed.packedSha256().equals(text(record.path("policy"), "rawSha256"))
                            && installed.packedBytes() == integer(record.path("policy"), "rawBytes", 8 * 1024 * 1024));
                    original = new Original(record);
                    originals.put(armId, original);
                    active = original;
                } else {
                    require(original != null && (original == active || original.unpublished != null));
                    original.accept(record, records);
                }
            }
            records.add(record);
            previous = text(record, "hash");
        }
        require(records.size() == head.sequence() && previous.equals(head.hash()));
        JsonNode source = records.getFirst().path("source");
        var identity = new SourceIdentity(text(source, "nodeUid"), text(source, "bootId"), text(source, "runtimeDigest"),
                source.path("runtimeStart").bigIntegerValue(), source.path("runtimePid").intValue(), text(source, "gatewayIncarnation"),
                text(source, "pluginDigest"), source.path("pluginStart").bigIntegerValue(), source.path("pluginPid").intValue(),
                CsiInstalledByteObservation.read(source.path("sourceArtifacts")), CsiInstalledByteObservation.read(source.path("gatewayArtifacts")));
        return new Stream(incarnation, identity, head, CsiNativeActivationProof.sha256(bytes),
                originals.values().stream().map(Original::observation).toList());
    }

    static JsonNode object(byte[] bytes, int limit) {
        require(bytes != null && bytes.length > 0 && bytes.length <= limit);
        try {
            String value = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
            JsonNode result = JSON.readTree(value);
            require(result != null && result.isObject());
            return result;
        } catch (IOException invalid) {
            throw new IllegalArgumentException("Invalid CSI node source JSON", invalid);
        }
    }

    static void fields(JsonNode value, List<String> expected) {
        require(value != null && value.isObject());
        var actual = new ArrayList<String>();
        value.fieldNames().forEachRemaining(actual::add);
        require(actual.equals(expected));
    }

    static String text(JsonNode value, String field) {
        require(value.path(field).isTextual());
        return value.path(field).textValue();
    }

    static long integer(JsonNode value, String field, long maximum) {
        JsonNode number = value.path(field);
        require(number.isIntegralNumber() && number.canConvertToLong() && number.longValue() >= 0
                && number.longValue() <= maximum);
        return number.longValue();
    }

    static void unsigned(JsonNode value, String field, boolean positive) {
        JsonNode number = value.path(field);
        require(number.isIntegralNumber() && number.bigIntegerValue().signum() >= (positive ? 1 : 0)
                && number.bigIntegerValue().compareTo(UINT64) <= 0);
    }

    private static void bounded(JsonNode value, String field, boolean empty) {
        String string = text(value, field);
        require((empty || !string.isEmpty()) && string.getBytes(StandardCharsets.UTF_8).length <= 2048
                && string.indexOf('\0') < 0);
    }

    private static void validate(JsonNode r) {
        String kind = text(r, "kind");
        var expected = new ArrayList<>(List.of("version", "incarnation", "sequence", "previous", "kind"));
        require("qwen-k2-node-source/7".equals(text(r, "version"))
                && text(r, "incarnation").matches("[0-9a-f]{32}")
                && text(r, "previous").matches("[0-9a-f]{64}") && text(r, "hash").matches("[0-9a-f]{64}"));
        if ("SOURCE_START".equals(kind)) {
            expected.add("source");
            require(integer(r, "sequence", 65536) == 1);
            JsonNode s = r.path("source");
            fields(s, List.of("nodeUid", "bootId", "runtimeDigest", "runtimeStart", "runtimePid", "gatewayIncarnation",
                    "pluginDigest", "pluginStart", "pluginPid", "sourceArtifacts", "gatewayArtifacts"));
            CsiInstalledByteObservation.requirePair(CsiInstalledByteObservation.read(s.path("sourceArtifacts")),
                    CsiInstalledByteObservation.read(s.path("gatewayArtifacts")));
            for (String f : List.of("nodeUid", "bootId")) {
                bounded(s, f, false);
            }
            for (String f : List.of("runtimeDigest", "pluginDigest")) {
                require(text(s, f).matches("[0-9a-f]{64}"));
            }
            require(text(s, "gatewayIncarnation").matches("[0-9a-f]{32}"));
            for (String f : List.of("runtimeStart", "pluginStart")) {
                unsigned(s, f, true);
            }
            for (String f : List.of("runtimePid", "pluginPid")) {
                require(integer(s, f, Integer.MAX_VALUE) > 0);
            }
        } else {
            require(integer(r, "sequence", 65536) > 1);
            expected.add("scope");
            JsonNode s = r.path("scope");
            fields(s, SCOPE);
            for (String f : SCOPE) {
                bounded(s, f, List.of("podUid", "containerId", "target", "retirementId").contains(f));
            }
            if ("ARM".equals(kind)) {
                for (String f : List.of("podUid", "containerId", "target", "retirementId")) {
                    require(text(s, f).isEmpty());
                }
            } else if (!"CONFINEMENT_LOST".equals(kind)) {
                require(!text(s, "podUid").isEmpty() && !text(s, "target").isEmpty());
            } else {
                require(text(s, "podUid").isEmpty() == text(s, "target").isEmpty()
                        && (!text(s, "podUid").isEmpty() || text(s, "containerId").isEmpty() && text(s, "retirementId").isEmpty()));
            }
            var extras = switch (kind) {
                case "ARM" -> List.of("imageDigest", "policy", "frontend");
                case "BIND" -> List.of("gatedSpecSha256", "podResourceVersion");
                case "CONFINEMENT_LOST" -> List.<String>of();
                case "PUBLISH_BEGIN" -> List.of("caller");
                case "CUSTODY_OPEN" -> List.of("begin", "custody", "runtime");
                case "BIRTH_PREPARED", "BIRTH_CREATED", "BIRTH_START_BEGIN", "BIRTH_STARTED", "BIRTH_NATIVE_DELETED" -> List.of("publish", "birth");
                case "PUBLISH_OK" -> List.of("begin", "target");
                case "PUBLISH_FAILED" -> List.of("begin", "status");
                case "STOP_INTENT" -> List.of("intentHash");
                case "ORIGINAL_STOPPED" -> List.of("begin", "publish", "custody", "runtime", "intentHash");
                case "UNPUBLISH_BEGIN" -> List.of("publish", "stop", "custody", "runtime", "caller");
                case "UNPUBLISH_OK" -> List.of("begin", "publish", "stop", "custody", "runtime");
                case "UNPUBLISH_FAILED" -> List.of("begin", "publish", "stop", "status");
                default -> throw new IllegalArgumentException("Unknown CSI node source record");
            };
            expected.addAll(extras);
            if ("ARM".equals(kind)) {
                require(text(r, "imageDigest").matches("[0-9a-f]{64}"));
                policy(r.path("policy"));
                JsonNode frontend = r.path("frontend");
                fields(frontend, List.of("kubelet", "registrar"));
                peer(frontend.path("kubelet"));
                peer(frontend.path("registrar"));
                require(!text(frontend.path("kubelet"), "digest").equals(text(frontend.path("registrar"), "digest")));
            }
            if ("BIND".equals(kind)) {
                require(text(r, "gatedSpecSha256").matches("[0-9a-f]{64}"));
                bounded(r, "podResourceVersion", false);
            }
            for (String f : List.of("begin", "publish", "stop")) {
                if (extras.contains(f)) {
                    Cursor c = cursor(r.path(f));
                    require(c.sequence() < integer(r, "sequence", 65536));
                }
            }
            if (extras.contains("intentHash")) {
                require(text(r, "intentHash").matches("[0-9a-f]{64}") && !text(s, "retirementId").isEmpty());
            }
            if (extras.contains("status")) {
                require(integer(r, "status", 16) > 0);
            }
            if (extras.contains("caller")) {
                peer(r.path("caller"));
            }
            if (extras.contains("target")) {
                fields(r.path("target"), List.of("device", "inode", "mountId"));
                unsigned(r.path("target"), "device", false);
                unsigned(r.path("target"), "inode", true);
                unsigned(r.path("target"), "mountId", true);
            }
            if (extras.contains("custody")) {
                custody(r);
            }
            if (extras.contains("birth")) {
                CsiNodeSourceBirth.validate(r);
            }
        }
        expected.add("hash");
        fields(r, expected);
        require(RECORD.containsAll(expected));
    }

    private static void peer(JsonNode p) {
        fields(p, List.of("pid", "startTicks", "digest"));
        require(integer(p, "pid", Integer.MAX_VALUE) > 0 && text(p, "digest").matches("[0-9a-f]{64}"));
        unsigned(p, "startTicks", true);
    }

    private static void policy(JsonNode p) {
        fields(p, List.of("kernelRelease", "sourceUserNamespace", "sourceMountNamespace", "sourceLsmLabel",
                "securityfsRoot", "apparmorfsRoot", "profileDirectory", "profileObject", "sourceProfileDirectory",
                "sourceProfileObject", "profileName", "profileMode", "globalMode", "lockPolicy",
                "namespaceRevision", "loadRevision", "rawAbi", "rawLink", "rawObject", "rawBytes", "rawSha256"));
        bounded(p, "kernelRelease", false);
        for (String name : List.of("sourceUserNamespace", "sourceMountNamespace", "profileObject", "sourceProfileObject", "rawObject")) {
            kernelObject(p.path(name));
        }
        for (String name : List.of("securityfsRoot", "apparmorfsRoot")) {
            JsonNode fs = p.path(name);
            fields(fs, List.of("device", "inode", "mountId", "type"));
            unsigned(fs, "device", false);
            unsigned(fs, "inode", true);
            unsigned(fs, "mountId", true);
            require(integer(fs, "type", 0xffffffffL) == ("securityfsRoot".equals(name) ? 0x73636673L : 0x5a3c69f0L));
        }
        for (String name : List.of("profileDirectory", "sourceProfileDirectory")) {
            require(text(p, name).matches("[A-Za-z0-9_.-]{1,255}") && !List.of(".", "..").contains(text(p, name)));
        }
        require(!text(p, "profileDirectory").equals(text(p, "sourceProfileDirectory"))
                && "qwen-k2-source-v1 (enforce)".equals(text(p, "sourceLsmLabel"))
                && "qwen-k2-worker-v1".equals(text(p, "profileName"))
                && "enforce".equals(text(p, "profileMode")) && "enforce".equals(text(p, "globalMode"))
                && p.path("lockPolicy").isBoolean() && p.path("lockPolicy").booleanValue()
                && text(p, "rawAbi").matches("v[5-9]")
                && integer(p, "rawBytes", 8 * 1024 * 1024) > 0 && text(p, "rawSha256").matches("[0-9a-f]{64}"));
        revision(text(p, "namespaceRevision"), true);
        revision(text(p, "loadRevision"), false);
        require(Long.parseLong(text(p, "loadRevision")) <= Long.parseLong(text(p, "namespaceRevision")));
        String link = text(p, "rawLink");
        require(link.startsWith("../../raw_data/") && link.endsWith("/raw_data"));
        revision(link.substring("../../raw_data/".length(), link.length() - "/raw_data".length()), false);
    }

    private static void kernelObject(JsonNode value) {
        fields(value, List.of("device", "inode"));
        unsigned(value, "device", false);
        unsigned(value, "inode", true);
    }

    private static void revision(String value, boolean positive) {
        require(value.matches("0|[1-9][0-9]{0,18}"));
        long number = Long.parseLong(value);
        require(!positive || number > 0);
    }

    private static void custody(JsonNode r) {
        JsonNode c = r.path("custody"), task = r.path("runtime"), scope = r.path("scope");
        fields(c, List.of("pid", "startTicks", "cgroupDevice", "cgroupInode", "coverage", "parentDevice", "parentInode", "populated", "terminal"));
        require(integer(c, "pid", 0xffffffffL) > 0 && c.path("populated").isBoolean() && c.path("terminal").isBoolean());
        for (String f : List.of("startTicks", "cgroupInode")) {
            unsigned(c, f, true);
        }
        unsigned(c, "cgroupDevice", false);
        unsigned(c, "parentDevice", false);
        unsigned(c, "parentInode", true);
        require("retained-pod-parent/1".equals(text(c, "coverage"))
                && c.path("parentDevice").bigIntegerValue().equals(c.path("cgroupDevice").bigIntegerValue())
                && !c.path("parentInode").bigIntegerValue().equals(c.path("cgroupInode").bigIntegerValue()));
        fields(task, List.of("version", "armId", "podUid", "containerId", "sandboxId", "imageDigest", "pid", "state",
                "exitStatus", "exitedAtNano"));
        require("qwen-k2-runtime-read/1".equals(text(task, "version")) && !text(scope, "containerId").isEmpty());
        for (String f : List.of("armId", "podUid", "containerId")) {
            require(text(scope, f).equals(text(task, f)));
        }
        for (String f : List.of("sandboxId", "imageDigest")) {
            require(text(task, f).matches("[0-9a-f]{64}"));
        }
        require(integer(task, "pid", 0xffffffffL) == integer(c, "pid", 0xffffffffL));
        integer(task, "exitStatus", 0xffffffffL);
        long exited = integer(task, "exitedAtNano", Long.MAX_VALUE);
        if (!"CUSTODY_OPEN".equals(text(r, "kind"))) {
            require(!c.path("populated").booleanValue() && c.path("terminal").booleanValue()
                    && "stopped".equals(text(task, "state")) && exited > 0);
        } else {
            require(c.path("populated").booleanValue() && !c.path("terminal").booleanValue()
                    && List.of("created", "running").contains(text(task, "state")) && exited == 0);
        }
    }

    static Cursor cursor(JsonNode c) {
        fields(c, List.of("sequence", "hash"));
        return new Cursor(integer(c, "sequence", 65536), text(c, "hash"));
    }

    private static Cursor recordCursor(JsonNode r) {
        return new Cursor(integer(r, "sequence", 65536), text(r, "hash"));
    }

    private static void dependency(JsonNode r, String name, JsonNode expected, List<JsonNode> records) {
        require(expected != null);
        Cursor c = cursor(r.path(name));
        require(c.equals(recordCursor(expected)) && records.get(Math.toIntExact(c.sequence() - 1)).equals(expected));
    }

    private static final class Original {
        private final JsonNode arm;
        private JsonNode scope, bound, opened, publishBegin, publish, intent, stopped, unpublishBegin, unpublished;
        private boolean blocked, lost;
        private final Map<String, Birth> births = new LinkedHashMap<>();

        private Original(JsonNode arm) {
            this.arm = arm;
            this.scope = arm.path("scope");
        }

        private void accept(JsonNode r, List<JsonNode> records) {
            String kind = text(r, "kind");
            require(unpublished == null && !lost && (!blocked || "CONFINEMENT_LOST".equals(kind)));
            JsonNode next = r.path("scope");
            for (String f : SCOPE) {
                if ("BIND".equals(kind) && List.of("podUid", "target").contains(f)
                        || "BIRTH_CREATED".equals(kind) && "container".equals(text(r.path("birth"), "role")) && "containerId".equals(f)
                        || "STOP_INTENT".equals(kind) && "retirementId".equals(f)) {
                    continue;
                }
                require(scope.path(f).equals(next.path(f)));
            }
            switch (kind) {
                case "BIRTH_PREPARED", "BIRTH_CREATED", "BIRTH_START_BEGIN", "BIRTH_STARTED", "BIRTH_NATIVE_DELETED" -> {
                    require(bound != null && publish != null && (!kind.equals("BIRTH_NATIVE_DELETED") ? intent == null : true));
                    dependency(r, "publish", publish, records);
                    String id = text(r.path("birth"), "id");
                    if (kind.equals("BIRTH_PREPARED")) {
                        require(!births.containsKey(id) && births.size() < 2);
                        for (Birth existing : births.values()) {
                            require(!text(existing.prepared.path("birth"), "role").equals(text(r.path("birth"), "role"))
                                    && existing.prepared.path("birth").path("sandboxId").equals(r.path("birth").path("sandboxId"))
                                    && existing.prepared.path("birth").path("peer").equals(r.path("birth").path("peer"))
                                    && existing.prepared.path("birth").path("policy").equals(r.path("birth").path("policy")));
                        }
                        if ("container".equals(text(r.path("birth"), "role"))) {
                            require(arm.path("imageDigest").equals(r.path("birth").path("imageRootfs").path("manifestSha256")));
                            Birth sandbox = births.get(text(r.path("birth"), "sandboxId"));
                            require(sandbox != null && sandbox.started != null && sandbox.deleted == null);
                        }
                        births.put(id, new Birth(r));
                    } else {
                        Birth born = births.get(id);
                        require(born != null);
                        born.accept(r, records);
                        if (kind.equals("BIRTH_CREATED") && "container".equals(text(r.path("birth"), "role"))) {
                            require(text(next, "containerId").equals(id));
                            Birth sandbox = births.get(text(r.path("birth"), "sandboxId"));
                            require(sandbox != null && sandbox.started != null);
                            JsonNode workerNs = r.path("birth").path("namespaces").path("namespaces");
                            JsonNode sandboxNs = sandbox.created.path("birth").path("namespaces").path("namespaces");
                            for (int index = 0; index < 7; index++) {
                                require(workerNs.get(index).equals(sandboxNs.get(index)) == (index >= 3));
                            }
                            require(r.path("birth").path("custody").path("parentDevice").equals(sandbox.created.path("birth").path("custody").path("parentDevice"))
                                    && r.path("birth").path("custody").path("parentInode").equals(sandbox.created.path("birth").path("custody").path("parentInode")));
                        }
                    }
                }
                case "BIND" -> {
                    require(bound == null);
                    bound = r;
                }
                case "CUSTODY_OPEN" -> {
                    require(bound != null && publish != null && opened == null);
                    require(arm.path("imageDigest").equals(r.path("runtime").path("imageDigest")));
                    Birth worker = births.get(text(next, "containerId"));
                    require(worker != null && worker.started != null);
                    dependency(r, "begin", worker.started, records);
                    require(r.path("runtime").path("sandboxId").equals(worker.prepared.path("birth").path("sandboxId")));
                    for (String field : List.of("pid", "startTicks", "cgroupDevice", "cgroupInode", "coverage", "parentDevice", "parentInode")) {
                        require(r.path("custody").path(field).equals(worker.created.path("birth").path("custody").path(field)));
                    }
                    opened = r;
                }
                case "PUBLISH_BEGIN" -> {
                    require(bound != null && publishBegin == null && intent == null);
                    require(r.path("caller").equals(arm.path("frontend").path("kubelet")));
                    publishBegin = r;
                }
                case "PUBLISH_OK", "PUBLISH_FAILED" -> {
                    require(publish == null && intent == null);
                    dependency(r, "begin", publishBegin, records);
                    if ("PUBLISH_OK".equals(kind)) {
                        publish = r;
                    } else {
                        blocked = true;
                    }
                }
                case "STOP_INTENT" -> {
                    require(bound != null && intent == null);
                    intent = r;
                }
                case "ORIGINAL_STOPPED" -> {
                    require(intent != null && stopped == null && text(intent, "intentHash").equals(text(r, "intentHash")));
                    dependency(r, "begin", opened, records);
                    dependency(r, "publish", publish, records);
                    for (String f : List.of("pid", "startTicks", "cgroupDevice", "cgroupInode", "coverage", "parentDevice", "parentInode")) {
                        require(opened.path("custody").path(f).asText().equals(r.path("custody").path(f).asText()));
                    }
                    for (String f : List.of("sandboxId", "imageDigest")) {
                        require(opened.path("runtime").path(f).equals(r.path("runtime").path(f)));
                    }
                    stopped = r;
                }
                case "UNPUBLISH_BEGIN" -> {
                    require(unpublishBegin == null);
                    dependency(r, "publish", publish, records);
                    dependency(r, "stop", stopped, records);
                    require(r.path("caller").equals(publishBegin.path("caller")));
                    require(r.path("custody").equals(stopped.path("custody"))
                            && r.path("runtime").equals(stopped.path("runtime")));
                    unpublishBegin = r;
                }
                case "UNPUBLISH_OK", "UNPUBLISH_FAILED" -> {
                    dependency(r, "begin", unpublishBegin, records);
                    dependency(r, "publish", publish, records);
                    dependency(r, "stop", stopped, records);
                    if ("UNPUBLISH_OK".equals(kind)) {
                        require(r.path("custody").equals(stopped.path("custody"))
                                && r.path("runtime").equals(stopped.path("runtime")));
                        unpublished = r;
                    } else {
                        blocked = true;
                    }
                }
                case "CONFINEMENT_LOST" -> {
                    blocked = true;
                    lost = true;
                }
                default -> throw new IllegalArgumentException("Invalid CSI node source transition");
            }
            scope = next;
        }

        private Observation observation() {
            String state = blocked ? "BLOCKED" : unpublished != null ? "UNPUBLISHED" : stopped != null ? "STOPPED"
                    : intent != null ? "STOP_INTENT" : publish != null ? "PUBLISHED" : opened != null ? "MONITORED"
                    : bound != null ? "BOUND" : "ARMED";
            var identity = new Scope(text(scope, "armId"), text(scope, "namespace"), text(scope, "podName"), text(scope, "podUid"),
                    text(scope, "containerId"), text(scope, "driver"), text(scope, "volumeId"), text(scope, "pvUid"),
                    text(scope, "pvcUid"), text(scope, "target"), text(scope, "bindingId"), text(scope, "retirementId"));
            return new Observation(identity, state, recordCursor(arm), bound == null ? null : recordCursor(bound),
                    opened == null ? null : recordCursor(opened), publish == null ? null : recordCursor(publish),
                    intent == null ? null : recordCursor(intent),
                    stopped == null ? null : recordCursor(stopped), unpublished == null ? null : recordCursor(unpublished),
                    births.values().stream().map(Birth::observation).toList());
        }
    }

    private static final class Birth {
        private final JsonNode prepared;
        private JsonNode created, startBegin, started, deleted;

        private Birth(JsonNode prepared) {
            this.prepared = prepared;
        }

        private BirthObservation observation() {
            JsonNode value = prepared.path("birth");
            return new BirthObservation(text(value, "role"), text(value, "id"), text(value, "sandboxId"),
                    text(value.path("imageRootfs"), "manifestSha256"), recordCursor(prepared),
                    created == null ? null : recordCursor(created), startBegin == null ? null : recordCursor(startBegin),
                    started == null ? null : recordCursor(started), deleted == null ? null : recordCursor(deleted));
        }

        private void accept(JsonNode record, List<JsonNode> records) {
            JsonNode b = record.path("birth");
            CsiNodeSourceBirth.sameBase(prepared.path("birth"), b);
            dependency(b, "prepared", prepared, records);
            String kind = text(record, "kind");
            require(deleted == null);
            if (kind.equals("BIRTH_CREATED")) {
                require(created == null);
                created = record;
                return;
            }
            require(created != null && b.path("namespaces").equals(created.path("birth").path("namespaces")));
            for (String field : List.of("pid", "startTicks", "cgroupDevice", "cgroupInode", "coverage", "parentDevice", "parentInode")) {
                require(b.path("custody").path(field).equals(created.path("birth").path("custody").path(field)));
            }
            if (kind.equals("BIRTH_START_BEGIN")) {
                require(startBegin == null && started == null);
                dependency(b, "created", created, records);
                startBegin = record;
            } else if (kind.equals("BIRTH_STARTED")) {
                require(startBegin != null && started == null);
                dependency(b, "created", created, records);
                dependency(b, "startBegin", startBegin, records);
                started = record;
            } else if (kind.equals("BIRTH_NATIVE_DELETED")) {
                deleted = record;
            } else {
                throw new IllegalArgumentException("Invalid original birth transition");
            }
        }
    }

    private static String goJson(JsonNode node) {
        if (node.isArray()) {
            var values = new ArrayList<String>();
            node.forEach(value -> values.add(goJson(value)));
            return "[" + String.join(",", values) + "]";
        }
        if (node.isObject()) {
            var fields = new ArrayList<String>();
            node.fields().forEachRemaining(f -> fields.add(quote(f.getKey()) + ":" + goJson(f.getValue())));
            return "{" + String.join(",", fields) + "}";
        }
        if (node.isTextual()) {
            return quote(node.textValue());
        }
        if (node.isIntegralNumber() || node.isBoolean()) {
            return node.asText();
        }
        throw new IllegalArgumentException("Unsupported CSI node source JSON value");
    }

    private static String quote(String value) {
        var out = new StringBuilder("\"");
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\b' -> out.append("\\b");
                case '\f' -> out.append("\\f");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                default -> {
                    if (c < 32 || c == '<' || c == '>' || c == '&' || c == '\u2028' || c == '\u2029') {
                        out.append(String.format(java.util.Locale.ROOT, "\\u%04x", (int) c));
                    } else if (Character.isHighSurrogate(c)) {
                        require(i + 1 < value.length() && Character.isLowSurrogate(value.charAt(i + 1)));
                        out.append(c).append(value.charAt(++i));
                    } else {
                        require(!Character.isLowSurrogate(c));
                        out.append(c);
                    }
                }
            }
        }
        return out.append('"').toString();
    }

    static void require(boolean valid) {
        if (!valid) {
            throw new IllegalArgumentException("Invalid CSI node source evidence");
        }
    }
}
