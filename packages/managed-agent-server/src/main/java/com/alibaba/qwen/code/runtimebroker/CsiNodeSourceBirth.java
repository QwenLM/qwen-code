package com.alibaba.qwen.code.runtimebroker;

import static com.alibaba.qwen.code.runtimebroker.CsiNodeSourceJournal.fields;
import static com.alibaba.qwen.code.runtimebroker.CsiNodeSourceJournal.integer;
import static com.alibaba.qwen.code.runtimebroker.CsiNodeSourceJournal.object;
import static com.alibaba.qwen.code.runtimebroker.CsiNodeSourceJournal.require;
import static com.alibaba.qwen.code.runtimebroker.CsiNodeSourceJournal.text;
import static com.alibaba.qwen.code.runtimebroker.CsiNodeSourceJournal.unsigned;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Closed source facts; deployment qualification remains a separate prerequisite. */
final class CsiNodeSourceBirth {
    private static final int LIMIT = 32 * 1024;
    private static final List<String> BASE = List.of("role", "id", "sandboxId", "peer", "policy", "objects",
            "originalRequest", "consumedRequest", "originalSpec", "consumedSpec", "imageRootfs", "metadataSha256");
    private static final List<String> OBJECT = List.of("device", "inode", "mountId", "bytes", "sha256", "flags", "mode",
            "modifiedSeconds", "modifiedNanos", "changedSeconds", "changedNanos");
    private static final List<String> CUSTODY = List.of("pid", "startTicks", "cgroupDevice", "cgroupInode", "coverage",
            "parentDevice", "parentInode", "populated", "terminal");

    private CsiNodeSourceBirth() {}

    static void validate(JsonNode record) {
        JsonNode b = record.path("birth"), scope = record.path("scope");
        String kind = text(record, "kind");
        var expected = new ArrayList<>(BASE);
        boolean kernel = !"BIRTH_PREPARED".equals(kind);
        boolean created = List.of("BIRTH_START_BEGIN", "BIRTH_STARTED").contains(kind);
        boolean started = "BIRTH_STARTED".equals(kind);
        boolean deleted = "BIRTH_NATIVE_DELETED".equals(kind);
        if (kernel) {
            expected.add("prepared");
        }
        if (created) {
            expected.add("created");
        }
        if (started) {
            expected.add("startBegin");
        }
        if (kernel) {
            expected.addAll(List.of("namespaces", "custody"));
        }
        if (deleted) {
            expected.add("nativeDelete");
        }
        fields(b, expected);
        String role = text(b, "role");
        require(List.of("container", "sandbox").contains(role));
        hash(b, "id");
        hash(b, "sandboxId");
        hash(b, "metadataSha256");
        CsiNodeSourceImage.validate(b.path("imageRootfs"));
        require(!"sandbox".equals(role) || text(b, "id").equals(text(b, "sandboxId")));
        JsonNode peer = b.path("peer");
        fields(peer, List.of("pid", "startTicks", "executable", "label"));
        unsigned(peer, "startTicks", true);
        require(integer(peer, "pid", Integer.MAX_VALUE) > 0
                && "qwen-k2-shim-v1".equals(text(peer, "label")));
        protectedObject(peer.path("executable"), true);
        JsonNode policy = b.path("policy");
        fields(policy, List.of("bundleRoot", "inputRoot", "runcPath", "runcRoot", "runcSha256"));
        for (String name : List.of("bundleRoot", "inputRoot", "runcPath", "runcRoot")) {
            path(text(policy, name));
        }
        String inputRoot = text(policy, "inputRoot");
        for (String name : List.of("bundleRoot", "runcRoot")) {
            require(!nested(inputRoot, text(policy, name)) && !nested(text(policy, name), inputRoot));
        }
        require(!nested(inputRoot, text(policy, "runcPath")));
        hash(policy, "runcSha256");
        byte[] originalRequest = raw(b, "originalRequest"), consumedRequest = raw(b, "consumedRequest");
        byte[] originalSpec = raw(b, "originalSpec"), consumedSpec = raw(b, "consumedSpec");
        require(originalRequest.length + consumedRequest.length + originalSpec.length + consumedSpec.length <= LIMIT);
        creation(originalRequest, consumedRequest, b, policy);
        spec(originalSpec, consumedSpec, b, scope);
        JsonNode objects = b.path("objects");
        require(objects.isArray() && objects.size() == 5);
        byte[][] contents = {consumedSpec, originalRequest, consumedRequest, originalSpec};
        for (int index = 0; index < contents.length; index++) {
            JsonNode measured = objects.get(index);
            protectedObject(measured, false);
            require(integer(measured, "bytes", LIMIT) == contents[index].length
                    && text(measured, "sha256").equals(CsiNativeActivationProof.sha256(contents[index])));
        }
        protectedObject(objects.get(4), true);
        require(text(objects.get(4), "sha256").equals(text(policy, "runcSha256")));
        for (String name : List.of("prepared", "created", "startBegin")) {
            if (b.has(name)) {
                require(CsiNodeSourceJournal.cursor(b.path(name)).sequence() < integer(record, "sequence", 65536));
            }
        }
        if (kernel) {
            JsonNode custody = b.path("custody");
            fields(custody, CUSTODY);
            for (String name : List.of("startTicks", "cgroupInode", "parentInode")) {
                unsigned(custody, name, true);
            }
            unsigned(custody, "cgroupDevice", false);
            unsigned(custody, "parentDevice", false);
            require(integer(custody, "pid", 0xffffffffL) > 0
                    && custody.path("parentDevice").equals(custody.path("cgroupDevice"))
                    && !custody.path("parentInode").equals(custody.path("cgroupInode"))
                    && "retained-pod-parent/1".equals(text(custody, "coverage"))
                    && custody.path("terminal").isBoolean() && custody.path("populated").isBoolean()
                    && custody.path("terminal").booleanValue() == deleted
                    && (deleted || custody.path("populated").booleanValue()));
            JsonNode ns = b.path("namespaces");
            fields(ns, List.of("namespaces", "root", "mountedRoot", "readonly"));
            require(ns.path("namespaces").isArray() && ns.path("namespaces").size() == 7
                    && ns.path("readonly").isBoolean() && ns.path("readonly").booleanValue());
            for (JsonNode namespace : ns.path("namespaces")) {
                fields(namespace, List.of("device", "inode"));
                unsigned(namespace, "device", false);
                unsigned(namespace, "inode", true);
            }
            for (String name : List.of("root", "mountedRoot")) {
                JsonNode root = ns.path(name);
                fields(root, List.of("device", "inode", "mountId", "type"));
                unsigned(root, "device", false);
                integer(root, "type", 0xffffffffL);
                unsigned(root, "inode", true);
                unsigned(root, "mountId", true);
            }
            require(ns.path("root").path("device").equals(ns.path("mountedRoot").path("device"))
                    && ns.path("root").path("inode").equals(ns.path("mountedRoot").path("inode")));
            if (deleted) {
                deletion(raw(b, "nativeDelete"), integer(custody, "pid", 0xffffffffL));
            }
        }
    }

    private static void protectedObject(JsonNode value, boolean executable) {
        fields(value, OBJECT);
        unsigned(value, "device", false);
        unsigned(value, "inode", true);
        unsigned(value, "mountId", true);
        require(integer(value, "bytes", executable ? 128 * 1024 * 1024 : LIMIT) > 0);
        hash(value, "sha256");
        long flags = integer(value, "flags", 0xffffffffL), mode = integer(value, "mode", 0xffffffffL);
        require((flags & 0x10) != 0 && (mode & 0170000) == 0100000 && (mode & 0222) == 0
                && (!executable || (mode & 0111) != 0));
        for (String name : List.of("modifiedSeconds", "changedSeconds")) {
            require(value.path(name).isIntegralNumber() && value.path(name).canConvertToLong());
        }
        integer(value, "modifiedNanos", 999999999);
        integer(value, "changedNanos", 999999999);
    }

    private static void spec(byte[] original, byte[] consumed, JsonNode birth, JsonNode scope) {
        ObjectNode before = (ObjectNode) object(original, LIMIT);
        JsonNode after = object(consumed, LIMIT);
        JsonNode annotations = before.path("annotations");
        require(text(annotations, "io.kubernetes.cri.container-type").equals(text(birth, "role"))
                && text(annotations, "io.kubernetes.cri.sandbox-id").equals(text(birth, "sandboxId"))
                && !annotations.has("io.containerd.runc.v2.group"));
        for (var names : Map.of("podUid", "sandbox-uid", "podName", "sandbox-name", "namespace", "sandbox-namespace").entrySet()) {
            require(text(scope, names.getKey()).equals(text(annotations, "io.kubernetes.cri." + names.getValue())));
        }
        ObjectNode expected = before.deepCopy();
        JsonNode process = expected.path("process"), linux = expected.path("linux");
        require(process.isObject() && linux.isObject() && expected.path("root").path("readonly").isBoolean()
                && expected.path("root").path("readonly").booleanValue()
                && "rootfs".equals(text(expected.path("root"), "path")) && !expected.has("hooks"));
        require(integer(process.path("user"), "uid", 0xffffffffL) == 1000
                && integer(process.path("user"), "gid", 0xffffffffL) == 1000);
        boolean sandbox = "sandbox".equals(text(birth, "role"));
        security(expected, sandbox);
        if (sandbox) {
            require(process.path("args").isArray() && process.path("args").size() == 1
                    && "/pause".equals(process.path("args").get(0).textValue()));
            ObjectNode changed = (ObjectNode) process;
            changed.put("noNewPrivileges", true);
            changed.put("apparmorProfile", "qwen-k2-sandbox-v1");
            changed.set("capabilities", changed.objectNode());
            ArrayNode namespaces = (ArrayNode) linux.path("namespaces");
            boolean cgroup = false;
            for (JsonNode namespace : namespaces) {
                cgroup |= "cgroup".equals(text(namespace, "type"));
            }
            if (!cgroup) {
                namespaces.addObject().put("type", "cgroup");
            }
        } else {
            require(Arrays.equals(original, consumed) && "runtime".equals(text(annotations, "io.kubernetes.cri.container-name")));
        }
        require(expected.equals(after));
    }

    private static void security(JsonNode spec, boolean sandbox) {
        JsonNode process = spec.path("process"), linux = spec.path("linux"), user = process.path("user");
        allowed(spec, Set.of("ociVersion", "process", "root", "hostname", "domainname", "mounts", "hooks", "annotations",
                "linux", "solaris", "windows", "vm", "zos", "freebsd"));
        allowed(process, Set.of("terminal", "consoleSize", "user", "args", "commandLine", "env", "cwd", "capabilities",
                "rlimits", "noNewPrivileges", "apparmorProfile", "oomScoreAdj", "scheduler", "selinuxLabel", "ioPriority", "execCPUAffinity"));
        allowed(user, Set.of("uid", "gid", "umask", "additionalGids", "username"));
        allowed(spec.path("root"), Set.of("path", "readonly"));
        allowed(linux, Set.of("uidMappings", "gidMappings", "sysctl", "resources", "cgroupsPath", "namespaces", "devices",
                "netDevices", "seccomp", "rootfsPropagation", "maskedPaths", "readonlyPaths", "mountLabel", "intelRdt", "memoryPolicy",
                "personality", "timeOffsets"));
        require(absentOrEmpty(user.path("username")) && absentOrFalse(process.path("terminal"))
                && !text(linux, "cgroupsPath").isEmpty());
        for (String field : List.of("windows", "solaris", "vm")) {
            require(!spec.hasNonNull(field));
        }
        for (String field : List.of("uidMappings", "gidMappings")) {
            require(emptyArray(linux.path(field)));
        }
        JsonNode groups = user.path("additionalGids");
        require(emptyArray(groups) || groups.isArray() && groups.size() == 1
                && groups.get(0).isIntegralNumber() && groups.get(0).canConvertToLong() && groups.get(0).longValue() == 1000);
        JsonNode namespaces = linux.path("namespaces");
        require(namespaces.isArray());
        var kinds = new java.util.HashSet<String>();
        var allowed = Set.of("mount", "pid", "network", "ipc", "uts", "cgroup");
        for (JsonNode namespace : namespaces) {
            String kind = text(namespace, "type");
            require(allowed.contains(kind) && kinds.add(kind));
            namespace.fieldNames().forEachRemaining(field -> require(Set.of("type", "path").contains(field)));
            JsonNode path = namespace.path("path");
            require(path.isMissingNode() || path.isNull() || path.isTextual());
            if (sandbox && !kind.equals("network") || !sandbox && Set.of("mount", "pid", "cgroup").contains(kind)) {
                require(absentOrEmpty(namespace.path("path")));
            }
        }
        require(kinds.containsAll(Set.of("mount", "pid", "network", "ipc", "uts"))
                && (sandbox || kinds.contains("cgroup")));
        JsonNode seccomp = linux.path("seccomp");
        require(seccomp.isObject() && !Set.of("SCMP_ACT_ALLOW", "SCMP_ACT_LOG").contains(text(seccomp, "defaultAction")));
        JsonNode privileges = process.path("noNewPrivileges"), capabilities = process.path("capabilities");
        require(privileges.isMissingNode() || privileges.isNull() || privileges.isBoolean());
        var capabilityNames = Set.of("bounding", "effective", "inheritable", "permitted", "ambient");
        if (!capabilities.isMissingNode() && !capabilities.isNull()) {
            allowed(capabilities, capabilityNames);
            for (String name : capabilityNames) {
                JsonNode values = capabilities.path(name);
                require(values.isMissingNode() || values.isNull() || values.isArray());
                for (JsonNode value : values) {
                    require(value.isTextual());
                }
            }
        }
        if (sandbox) {
            require(absentOrEmpty(process.path("apparmorProfile")));
        } else {
            require(process.path("noNewPrivileges").isBoolean() && process.path("noNewPrivileges").booleanValue()
                    && "qwen-k2-worker-v1".equals(text(process, "apparmorProfile"))
                    && process.path("args").isArray() && !process.path("args").isEmpty());
            require(capabilities.isObject());
            for (String name : capabilityNames) {
                require(emptyArray(capabilities.path(name)));
            }
        }
    }

    private static boolean emptyArray(JsonNode value) {
        return value.isMissingNode() || value.isNull() || value.isArray() && value.isEmpty();
    }

    private static void allowed(JsonNode value, Set<String> fields) {
        require(value.isObject());
        value.fieldNames().forEachRemaining(field -> require(fields.contains(field)));
    }

    private static boolean absentOrEmpty(JsonNode value) {
        return value.isMissingNode() || value.isNull() || value.isTextual() && value.textValue().isEmpty();
    }

    private static boolean absentOrFalse(JsonNode value) {
        return value.isMissingNode() || value.isNull() || value.isBoolean() && !value.booleanValue();
    }

    private static void creation(byte[] original, byte[] consumed, JsonNode birth, JsonNode policy) {
        var before = wire(original, 10, 3);
        var after = wire(consumed, 10, 3);
        require(string(before, 1).equals(text(birth, "id")) && string(before, 2).equals(text(policy, "bundleRoot") + "/" + text(birth, "id"))
                && string(after, 1).equals(text(birth, "id")) && string(after, 2).equals(text(policy, "inputRoot") + "/" + text(birth, "id")));
        require(!before.containsKey(4) && !before.containsKey(8) && !before.containsKey(9)
                && before.containsKey(3) && before.get(3).size() <= 8 && before.containsKey(10));
        for (byte[] mount : before.get(3)) {
            require(mount[0] == 2);
            var fields = wire(Arrays.copyOfRange(mount, 1, mount.length), 4, 4);
            require(!string(fields, 1).isEmpty() && !string(fields, 2).isEmpty()
                    && (!fields.containsKey(3) || string(fields, 3).isEmpty())
                    && (!fields.containsKey(4) || fields.get(4).size() <= 64));
            for (byte[] option : fields.getOrDefault(4, List.of())) {
                stringValue(option);
            }
        }
        io(before, birth, policy);
        before.remove(2);
        after.remove(2);
        require(before.keySet().equals(after.keySet()));
        for (int field : before.keySet()) {
            require(before.get(field).size() == after.get(field).size());
            for (int index = 0; index < before.get(field).size(); index++) {
                require(Arrays.equals(before.get(field).get(index), after.get(field).get(index)));
            }
        }
        var any = wire(message(before, 10), 2, -1);
        require("containerd.runc.v1.Options".equals(string(any, 1)) && any.containsKey(2));
        var options = wire(message(any, 2), 13, -1);
        require(string(options, 6).equals(text(policy, "runcPath")) && string(options, 7).equals(text(policy, "runcRoot"))
                && number(options, 9) == 1);
        for (int field : options.keySet()) {
            switch (field) {
                case 6, 7, 9 -> {
                    continue;
                }
                case 1, 2, 4, 5, 13 -> require(number(options, field) == 0);
                case 3, 10, 11, 12 -> require(string(options, field).isEmpty());
                default -> throw new IllegalArgumentException("Unsupported original runc option");
            }
        }
    }

    private static void io(Map<Integer, List<byte[]>> request, JsonNode birth, JsonNode policy) {
        require(!request.containsKey(5) || string(request, 5).isEmpty());
        String stdout = request.containsKey(6) ? string(request, 6) : "";
        String stderr = request.containsKey(7) ? string(request, 7) : "";
        if (stdout.isEmpty() && stderr.isEmpty()) {
            return;
        }
        path(stdout);
        path(stderr);
        String bundle = text(policy, "bundleRoot"), suffix = "/io.containerd.runtime.v2.task/k8s.io";
        require(bundle.endsWith(suffix) && bundle.length() > suffix.length());
        String id = text(birth, "id");
        Path root = Path.of(bundle.substring(0, bundle.length() - suffix.length()), "io.containerd.grpc.v1.cri", "containers", id, "io");
        Path out = Path.of(stdout), error = Path.of(stderr);
        require(out.getParent() != null && out.getParent().getParent() != null
                && root.equals(out.getParent().getParent()) && out.getParent().equals(error.getParent())
                && (id + "-stdout").equals(out.getFileName().toString()) && (id + "-stderr").equals(error.getFileName().toString()));
    }

    private static void deletion(byte[] raw, long pid) {
        var fields = wire(raw, 3, -1);
        require(number(fields, 1) == pid && number(fields, 2) >= 0 && number(fields, 2) <= 0xffffffffL && fields.containsKey(3));
        byte[] timestampRaw = message(fields, 3);
        Map<Integer, List<byte[]>> timestamp = timestampRaw.length == 0 ? Map.of() : wire(timestampRaw, 2, -1);
        long seconds = number(timestamp, 1), nanos = number(timestamp, 2);
        require(seconds >= -62135596800L && seconds <= 253402300799L && nanos >= 0 && nanos <= 999999999);
    }

    private static Map<Integer, List<byte[]>> wire(byte[] raw, int maximum, int repeated) {
        require(raw.length > 0 && raw.length <= LIMIT);
        var input = ByteBuffer.wrap(raw);
        var result = new LinkedHashMap<Integer, List<byte[]>>();
        while (input.hasRemaining()) {
            long tag = varint(input);
            long fieldNumber = tag >>> 3;
            require(fieldNumber > 0 && fieldNumber <= maximum);
            int field = (int) fieldNumber, kind = (int) (tag & 7);
            require(field > 0 && field <= maximum && (kind == 0 || kind == 2) && (field == repeated || !result.containsKey(field)));
            byte[] value;
            if (kind == 2) {
                long size = varint(input);
                require(size >= 0 && size <= input.remaining());
                value = new byte[(int) size + 1];
                value[0] = 2;
                input.get(value, 1, (int) size);
            } else {
                value = ByteBuffer.allocate(9).put((byte) 0).putLong(varint(input)).array();
            }
            result.computeIfAbsent(field, unused -> new ArrayList<>()).add(value);
        }
        return result;
    }

    private static long varint(ByteBuffer input) {
        long value = 0;
        for (int index = 0; index < 10; index++) {
            require(input.hasRemaining());
            int next = input.get() & 0xff;
            require(index != 9 || next <= 1);
            value |= (long) (next & 0x7f) << (index * 7);
            if (next < 128) {
                require(index == 0 || next != 0);
                return value;
            }
        }
        throw new IllegalArgumentException("Invalid original birth protobuf");
    }

    private static String string(Map<Integer, List<byte[]>> fields, int name) {
        require(fields.containsKey(name) && fields.get(name).size() == 1);
        return stringValue(fields.get(name).getFirst());
    }

    private static String stringValue(byte[] raw) {
        require(raw[0] == 2);
        byte[] value = Arrays.copyOfRange(raw, 1, raw.length);
        String result = new String(value, StandardCharsets.UTF_8);
        require(Arrays.equals(value, result.getBytes(StandardCharsets.UTF_8)));
        return result;
    }

    private static byte[] message(Map<Integer, List<byte[]>> fields, int name) {
        require(fields.containsKey(name) && fields.get(name).size() == 1);
        byte[] value = fields.get(name).getFirst();
        require(value.length >= 1 && value[0] == 2);
        return Arrays.copyOfRange(value, 1, value.length);
    }

    static void sameBase(JsonNode first, JsonNode next) {
        for (String field : BASE) {
            require(first.path(field).equals(next.path(field)));
        }
    }

    private static long number(Map<Integer, List<byte[]>> fields, int name) {
        if (!fields.containsKey(name)) {
            return 0;
        }
        byte[] raw = fields.get(name).getFirst();
        require(raw[0] == 0 && raw.length == 9);
        return ByteBuffer.wrap(raw, 1, 8).getLong();
    }

    private static byte[] raw(JsonNode node, String name) {
        String value = text(node, name);
        require(value.length() <= ((LIMIT + 2) / 3) * 4);
        byte[] raw = Base64.getDecoder().decode(value);
        require(raw.length > 0 && raw.length <= LIMIT && Base64.getEncoder().encodeToString(raw).equals(value));
        return raw;
    }

    private static void hash(JsonNode value, String name) {
        require(text(value, name).matches("[0-9a-f]{64}"));
    }

    private static void path(String value) {
        require(value.getBytes(StandardCharsets.UTF_8).length <= 1024 && !value.equals("/") && value.indexOf('\0') < 0
                && value.indexOf('\r') < 0 && value.indexOf('\n') < 0 && Path.of(value).isAbsolute()
                && Path.of(value).normalize().toString().equals(value));
    }

    private static boolean nested(String parent, String child) {
        return parent.equals(child) || child.startsWith(parent + "/");
    }
}
