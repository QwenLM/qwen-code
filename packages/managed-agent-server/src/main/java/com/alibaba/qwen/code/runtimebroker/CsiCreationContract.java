package com.alibaba.qwen.code.runtimebroker;

import static com.alibaba.qwen.code.runtimebroker.CsiNodeSourceJournal.object;
import static com.alibaba.qwen.code.runtimebroker.CsiNodeSourceJournal.require;
import static com.alibaba.qwen.code.runtimebroker.CsiNodeSourceJournal.text;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.file.Path;
import java.util.List;
import java.util.Set;

/** Exact reviewed creation inputs; this data comparison grants no installation authority. */
public final class CsiCreationContract {
    public static final int LIMIT = 16 * 1024;
    private static final List<String> ROLE = List.of("args", "env", "cwd", "seccomp", "mounts", "devices",
            "deviceCgroupRules", "maskedPaths", "readonlyPaths");

    private CsiCreationContract() {}

    public static void validate(byte[] raw) {
        var document = object(raw, LIMIT);
        closed(document, List.of("format", "worker", "sandbox"));
        require("qwen-k2-creation-contract/1".equals(text(document, "format")));
        for (String name : List.of("worker", "sandbox")) {
            var role = document.path(name);
            closed(role, ROLE);
            strings(role.path("args"), 64);
            require(!role.path("args").isEmpty());
            strings(role.path("env"), 128);
            if (!"/".equals(text(role, "cwd"))) {
                path(text(role, "cwd"));
            }
            seccomp(role.path("seccomp"));
            array(role.path("mounts"), 64);
            for (var mount : role.path("mounts")) {
                optionalFields(mount, Set.of("destination", "type", "source", "options", "uidMappings", "gidMappings"));
                path(text(mount, "destination"));
                require(!text(mount, "type").isEmpty() && !text(mount, "source").isEmpty());
                expand(text(mount, "source"), "a".repeat(64), "b".repeat(64), "00000000-0000-4000-8000-000000000001");
                optionalStrings(mount.path("options"), 64);
                for (String mappings : List.of("uidMappings", "gidMappings")) {
                    var value = mount.path(mappings);
                    require(value.isMissingNode() || value.isNull() || value.isArray() && value.isEmpty());
                }
            }
            array(role.path("devices"), 64);
            for (var device : role.path("devices")) {
                optionalFields(device, Set.of("path", "type", "major", "minor", "fileMode", "uid", "gid"));
                for (String value : List.of("path", "type")) {
                    require(!text(device, value).isEmpty());
                }
                for (String value : List.of("major", "minor")) {
                    signed(device.path(value));
                }
                for (String value : List.of("fileMode", "uid", "gid")) {
                    optionalUnsigned(device.path(value), 32);
                }
            }
            array(role.path("deviceCgroupRules"), 128);
            for (var rule : role.path("deviceCgroupRules")) {
                optionalFields(rule, Set.of("allow", "type", "major", "minor", "access"));
                require(rule.path("allow").isBoolean());
                for (String value : List.of("type", "access")) {
                    optionalText(rule.path(value));
                }
                for (String value : List.of("major", "minor")) {
                    if (rule.hasNonNull(value)) {
                        signed(rule.path(value));
                    }
                }
            }
            strings(role.path("maskedPaths"), 128);
            strings(role.path("readonlyPaths"), 128);
            require(role.path("maskedPaths").size() + role.path("readonlyPaths").size() <= 128);
        }
        var args = document.path("sandbox").path("args");
        require(args.size() == 1 && "/pause".equals(args.get(0).textValue()));
    }

    public static void requireMatch(byte[] contract, byte[] originalSpec, String id) {
        validate(contract);
        var spec = object(originalSpec, 32 * 1024);
        var annotations = spec.path("annotations");
        String sandbox = text(annotations, "io.kubernetes.cri.sandbox-id");
        String uid = text(annotations, "io.kubernetes.cri.sandbox-uid");
        require(id != null && id.matches("[0-9a-f]{64}") && sandbox.matches("[0-9a-f]{64}")
                && uid.matches("[a-z0-9][a-z0-9-]{0,127}"));
        String kind = text(annotations, "io.kubernetes.cri.container-type");
        require(List.of("container", "sandbox").contains(kind) && (!kind.equals("sandbox") || id.equals(sandbox)));
        ObjectNode expected = object(contract, LIMIT).path(kind.equals("sandbox") ? "sandbox" : "worker").deepCopy();
        for (var mount : expected.path("mounts")) {
            ((ObjectNode) mount).put("source", expand(text(mount, "source"), id, sandbox, uid));
        }
        var actual = expected.objectNode();
        var process = spec.path("process");
        var linux = spec.path("linux");
        require(process.isObject() && linux.isObject());
        actual.set("args", process.path("args"));
        actual.set("env", listOrEmpty(process.path("env"), actual));
        actual.set("cwd", process.path("cwd"));
        actual.set("seccomp", linux.path("seccomp"));
        actual.set("mounts", listOrEmpty(spec.path("mounts"), actual));
        actual.set("devices", listOrEmpty(linux.path("devices"), actual));
        actual.set("deviceCgroupRules", listOrEmpty(linux.path("resources").path("devices"), actual));
        actual.set("maskedPaths", listOrEmpty(linux.path("maskedPaths"), actual));
        actual.set("readonlyPaths", listOrEmpty(linux.path("readonlyPaths"), actual));
        require(expected.equals(actual));
    }

    private static JsonNode listOrEmpty(JsonNode value, ObjectNode factory) {
        return value.isMissingNode() || value.isNull() ? factory.arrayNode() : value;
    }

    private static String expand(String source, String id, String sandbox, String uid) {
        String value = source.replace("${POD_UID_SYSTEMD}", uid.replace('-', '_')).replace("${POD_UID}", uid)
                .replace("${CONTAINER_ID}", id).replace("${SANDBOX_ID}", sandbox);
        require(value.length() <= 1024 && !value.matches("(?s).*[$*?\\[\\]{}@\\x00\\r\\n].*"));
        if (value.startsWith("/")) {
            path(value);
        }
        return value;
    }

    private static void seccomp(JsonNode program) {
        optionalFields(program, Set.of("defaultAction", "defaultErrnoRet", "architectures", "flags", "listenerPath", "listenerMetadata", "syscalls"));
        require(!text(program, "defaultAction").isEmpty()
                && !Set.of("SCMP_ACT_ALLOW", "SCMP_ACT_LOG").contains(text(program, "defaultAction")));
        optionalUnsigned(program.path("defaultErrnoRet"), 64);
        optionalStrings(program.path("architectures"), LIMIT);
        optionalStrings(program.path("flags"), LIMIT);
        optionalText(program.path("listenerPath"));
        optionalText(program.path("listenerMetadata"));
        var syscalls = program.path("syscalls");
        if (!syscalls.isMissingNode() && !syscalls.isNull()) {
            array(syscalls, LIMIT);
            for (var syscall : syscalls) {
                optionalFields(syscall, Set.of("names", "action", "errnoRet", "args"));
                optionalStrings(syscall.path("names"), LIMIT);
                optionalText(syscall.path("action"));
                optionalUnsigned(syscall.path("errnoRet"), 64);
                var args = syscall.path("args");
                if (!args.isMissingNode() && !args.isNull()) {
                    array(args, LIMIT);
                    for (var arg : args) {
                        optionalFields(arg, Set.of("index", "value", "valueTwo", "op"));
                        for (String name : List.of("index", "value", "valueTwo")) {
                            optionalUnsigned(arg.path(name), 64);
                        }
                        optionalText(arg.path("op"));
                    }
                }
            }
        }
    }

    private static void optionalFields(JsonNode value, Set<String> allowed) {
        require(value.isObject());
        value.fieldNames().forEachRemaining(name -> require(allowed.contains(name)));
    }

    private static void closed(JsonNode value, List<String> names) {
        optionalFields(value, Set.copyOf(names));
        require(value.size() == names.size());
    }

    private static void array(JsonNode value, int maximum) {
        require(value.isArray() && value.size() <= maximum);
    }
    private static void strings(JsonNode value, int maximum) {
        array(value, maximum);
        for (var entry : value) {
            require(entry.isTextual());
        }
    }
    private static void optionalStrings(JsonNode value, int maximum) {
        if (!value.isMissingNode() && !value.isNull()) {
            strings(value, maximum);
        }
    }
    private static void optionalText(JsonNode value) {
        require(value.isMissingNode() || value.isNull() || value.isTextual());
    }
    private static void optionalUnsigned(JsonNode value, int bits) {
        require(value.isMissingNode() || value.isNull() || value.isIntegralNumber()
                && value.bigIntegerValue().signum() >= 0 && value.bigIntegerValue().bitLength() <= bits);
    }
    private static void signed(JsonNode value) {
        require(value.isMissingNode() || value.isNull() || value.isIntegralNumber() && value.canConvertToLong());
    }
    private static void path(String value) {
        require(value.length() <= 1024 && !value.equals("/") && value.indexOf('\0') < 0 && value.indexOf('\r') < 0
                && value.indexOf('\n') < 0 && Path.of(value).isAbsolute() && Path.of(value).normalize().toString().equals(value));
    }
}
