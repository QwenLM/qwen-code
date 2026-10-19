package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.runtimebroker.CsiCreationContract;
import com.alibaba.qwen.code.runtimebroker.CsiInstalledByteObservation;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.commons.codec.digest.DigestUtils;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.Base64;
import java.util.Set;

import static com.alibaba.qwen.code.managedagent.store.WorkspaceCsiApplicationJson.closed;
import static com.alibaba.qwen.code.managedagent.store.WorkspaceCsiApplicationJson.object;
import static com.alibaba.qwen.code.managedagent.store.WorkspaceCsiApplicationJson.require;

/** Reads independent reviewed metadata; it never reads referenced credentials or installs files. */
final class WorkspaceCsiInstalledBytes {
    private static final Set<String> FILES = Set.of("artifact-manifest.json", "shim.json", "profile-candidate.json",
            "profile-compile.json", "source-config.json", "source-config.installed.json", "gateway-config.json",
            "target.json", "runtime.json", "creation-contract.json", "qwen-k2-node-source.service",
            "qwen-k2-runtime-gateway.service", "features", "qwen-k2-profiles", "worker-catalog.json",
            "sandbox-catalog.json", "packed.bin", "host-policies.json", "host-runtime.rules", "host-kubelet.rules",
            "host-registrar.rules", "host-plugin.rules", "host-systemd.rules", "host-system-bus.rules", "cold-bootstrap.json");
    private static final Set<String> HOST_BASES = Set.of("host-runtime.rules", "host-kubelet.rules",
            "host-registrar.rules", "host-plugin.rules", "host-systemd.rules", "host-system-bus.rules");

    private WorkspaceCsiInstalledBytes() { }

    static WorkspaceCsiNodeSourceStore.InstalledBytes read(Path directory, byte[] source, byte[] shim) throws IOException {
        require(directory != null && directory.isAbsolute() && directory.equals(directory.normalize()));
        byte[] manifestRaw = read(directory.resolve("installation.json"), 64 * 1024);
        JsonNode manifest = object(manifestRaw, 64 * 1024);
        closed(manifest, Set.of("format", "files"));
        require("qwen-k2-installed-artifacts/3".equals(text(manifest, "format")));
        JsonNode pins = manifest.path("files");
        closed(pins, FILES);
        long total = manifestRaw.length;
        for (String name : FILES) {
            JsonNode pin = pins.path(name);
            closed(pin, Set.of("bytes", "sha256"));
            int limit = switch (name) {
                case "packed.bin" -> 8 * 1024 * 1024;
                case "qwen-k2-profiles", "worker-catalog.json", "sandbox-catalog.json" -> 16 * 1024 * 1024;
                case "shim.json", "source-config.json", "source-config.installed.json", "gateway-config.json", "target.json",
                        "qwen-k2-node-source.service", "qwen-k2-runtime-gateway.service" -> 32 * 1024;
                case "creation-contract.json" -> CsiCreationContract.LIMIT;
                default -> HOST_BASES.contains(name) ? 1024 * 1024 : 64 * 1024;
            };
            total += positive(pin, "bytes", limit);
            require(text(pin, "sha256").matches("[0-9a-f]{64}"));
        }
        require(total <= 64 * 1024 * 1024);
        require(Arrays.equals(source, pinned(directory, pins, "source-config.installed.json", 32 * 1024))
                && Arrays.equals(shim, pinned(directory, pins, "shim.json", 32 * 1024)));
        JsonNode sourceValue = object(source, 32 * 1024);
        JsonNode shimValue = object(shim, 32 * 1024);
        byte[] profileRaw = pinned(directory, pins, "profile-candidate.json", 64 * 1024);
        JsonNode profile = object(profileRaw, 64 * 1024);
        closed(profile, Set.of("format", "artifactManifestSha256", "shimConfigurationSha256", "roleConfigPaths",
                "boundaries", "generators", "files"));
        require("qwen-k2-profile-candidate/3".equals(text(profile, "format"))
                && DigestUtils.sha256Hex(shim).equals(text(profile, "shimConfigurationSha256")));
        JsonNode paths = profile.path("roleConfigPaths");
        closed(paths, Set.of("source", "gateway"));
        JsonNode profileFiles = profile.path("files");
        Set<String> profileNames = Set.of("source-config.json", "gateway-config.json", "target.json", "runtime.json",
                "creation-contract.json", "qwen-k2-node-source.service", "qwen-k2-runtime-gateway.service", "qwen-k2-profiles",
                "host-policies.json", "host-runtime.rules", "host-kubelet.rules", "host-registrar.rules",
                "host-plugin.rules", "host-systemd.rules", "host-system-bus.rules", "cold-bootstrap.json");
        closed(profileFiles, profileNames);
        for (String name : profileNames) {
            require(profileFiles.path(name).equals(pins.path(name)));
        }
        cold(directory, pins, readCold(pinned(directory, pins, "cold-bootstrap.json", 64 * 1024)));
        JsonNode hostPolicies = object(pinned(directory, pins, "host-policies.json", 64 * 1024), 64 * 1024);
        closed(hostPolicies, Set.of("format", "files"));
        require("qwen-k2-host-policies/1".equals(text(hostPolicies, "format")));
        JsonNode hostPins = hostPolicies.path("files");
        closed(hostPins, HOST_BASES);
        for (String name : HOST_BASES) {
            require(hostPins.path(name).equals(pins.path(name)));
            pinned(directory, pins, name, 1024 * 1024);
        }
        byte[] artifactsRaw = pinned(directory, pins, "artifact-manifest.json", 64 * 1024);
        require(DigestUtils.sha256Hex(artifactsRaw).equals(text(profile, "artifactManifestSha256")));
        JsonNode artifacts = object(artifactsRaw, 64 * 1024);
        closed(artifacts, Set.of("format", "artifacts", "creationContractSha256", "sandboxImageSha256",
                "workerImageSha256", "catalogues", "generators"));
        require("qwen-k2-pre-exec-artifacts/2".equals(text(artifacts, "format")));
        require(DigestUtils.sha256Hex(Base64.getDecoder().decode(text(shimValue, "creationContract")))
                        .equals(text(artifacts, "creationContractSha256"))
                && text(sourceValue, "sandboxImageSha256").equals(text(artifacts, "sandboxImageSha256")));
        JsonNode executables = artifacts.path("artifacts");
        closed(executables, Set.of("source", "shim", "runc"));
        String architecture = text(executables.path("source"), "architecture");
        for (String name : Set.of("source", "shim", "runc")) {
            JsonNode executable = executables.path(name);
            closed(executable, Set.of("sha256", "bytes", "architecture"));
            require(positive(executable, "bytes", 128 * 1024 * 1024) >= 64);
            require(architecture.equals(text(executable, "architecture"))
                    && text(executable, "sha256").matches("[0-9a-f]{64}"));
        }
        require(text(executables.path("source"), "sha256").equals(text(shimValue, "sourceSha256"))
                && text(executables.path("shim"), "sha256").equals(text(shimValue, "shimSha256"))
                && text(executables.path("runc"), "sha256").equals(text(shimValue.path("inputs"), "runcSha256")));
        JsonNode compilation = object(pinned(directory, pins, "profile-compile.json", 64 * 1024), 64 * 1024);
        closed(compilation, Set.of("format", "command", "profileCandidateSha256", "parserSha256", "featuresSha256",
                "sourceSha256", "parserConfigurationSha256", "generatorSha256", "exitCode", "packedBytes", "packedSha256"));
        require("qwen-k2-profile-compile/2".equals(text(compilation, "format"))
                && compilation.path("exitCode").isIntegralNumber() && compilation.path("exitCode").canConvertToLong()
                && compilation.path("exitCode").longValue() == 0
                && DigestUtils.sha256Hex(profileRaw).equals(text(compilation, "profileCandidateSha256"))
                && text(pins.path("features"), "sha256").equals(text(compilation, "featuresSha256"))
                && text(pins.path("qwen-k2-profiles"), "sha256").equals(text(compilation, "sourceSha256")));
        int packedBytes = positive(compilation, "packedBytes", 8 * 1024 * 1024);
        String packed = text(compilation, "packedSha256");
        require(packed.equals(text(sourceValue, "workerPolicySha256"))
                && packed.equals(text(pins.path("packed.bin"), "sha256"))
                && packedBytes == positive(pins.path("packed.bin"), "bytes", 8 * 1024 * 1024));
        String installation = DigestUtils.sha256Hex(manifestRaw);
        var sourceExpected = observation("source", installation, architecture, packed, packedBytes, text(paths, "source"),
                source, shim, pinned(directory, pins, "qwen-k2-node-source.service", 32 * 1024));
        var gatewayExpected = observation("gateway", installation, architecture, packed, packedBytes, text(paths, "gateway"),
                pinned(directory, pins, "gateway-config.json", 32 * 1024), shim,
                pinned(directory, pins, "qwen-k2-runtime-gateway.service", 32 * 1024));
        return new WorkspaceCsiNodeSourceStore.InstalledBytes(sourceExpected, gatewayExpected,
                text(sourceValue, "kubeletDigest"), text(sourceValue, "registrarDigest"));
    }

    private static JsonNode readCold(byte[] raw) throws IOException {
        JsonNode value = object(raw, 64 * 1024);
        closed(value, Set.of("format", "entryKind", "architecture", "kernel", "baseInitrd", "initrdInputs", "coldInit",
                "systemd", "systemdDependencies", "linkPlan", "bootState", "rootfsPlan", "generators"));
        require("qwen-k2-cold-bootstrap/1".equals(text(value, "format"))
                && "initramfs-tools-run-init-first-systemd".equals(text(value, "entryKind"))
                && "amd64".equals(text(value, "architecture")));
        JsonNode loader = value.path("coldInit");
        closed(loader, Set.of("path", "bytes", "sha256"));
        require("/opt/qwen-k2/bin/k2-cold-init".equals(text(loader, "path"))
                && positive(loader, "bytes", 128 * 1024 * 1024) >= 64
                && text(loader, "sha256").matches("[0-9a-f]{64}"));
        JsonNode systemd = value.path("systemd");
        closed(systemd, Set.of("path", "bytes", "sha256", "label"));
        String label = text(systemd, "label");
        require(label.matches("[A-Za-z0-9/][A-Za-z0-9._/-]{0,252}") && !label.contains("//")
                && !label.endsWith("/") && !label.equals("unconfined") && !label.startsWith("qwen-k2-"));
        closed(value.path("generators"), Set.of("render-cold-boot.py", "package-cold-initrd.py", "cold_boot.py", "cold-lane.json"));
        value.path("generators").elements().forEachRemaining(v -> require(v.isTextual() && v.textValue().matches("[0-9a-f]{64}")));
        JsonNode scripts = value.path("bootState").path("scriptOutputs");
        require(scripts.isObject() && scripts.size() >= 7 && scripts.size() <= 256);
        Set<String> mandatory = Set.of("/init", "/scripts/functions", "/scripts/init-top/udev", "/scripts/init-bottom/udev",
                "/scripts/init-top/ORDER", "/scripts/init-bottom/ORDER", "/scripts/local-bottom/ORDER");
        for (String name : mandatory) {
            require(scripts.has(name));
        }
        var names = scripts.fieldNames();
        while (names.hasNext()) {
            String name = names.next();
            require(coldPath(name) && (mandatory.contains(name) || name.matches("/scripts/[A-Za-z0-9._-]+/ORDER")));
            closed(scripts.path(name), Set.of("bytes", "sha256"));
            positive(scripts.path(name), "bytes", 1024 * 1024);
            require(text(scripts.path(name), "sha256").matches("[0-9a-f]{64}"));
        }
        JsonNode links = value.path("linkPlan");
        require(links.isObject() && links.size() <= 64);
        names = links.fieldNames();
        while (names.hasNext()) {
            String name = names.next();
            require(coldPath(name) && (name.equals("/lib") || name.equals("/lib64")
                    || name.startsWith("/usr/lib/") || name.startsWith("/usr/lib64/")));
            String target = text(links, name);
            require(target.length() <= 2048 && !target.contains("\0") && !target.contains("\r") && !target.contains("\n"));
        }
        require(value.path("systemdDependencies").isArray() && value.path("systemdDependencies").size() == 24);
        for (JsonNode dependency : value.path("systemdDependencies")) {
            require(resolveCold(text(dependency, "lookupPath"), links).equals(text(dependency, "path")));
        }
        ObjectNode normalized = value.deepCopy();
        ((ObjectNode) normalized.path("coldInit")).put("bytes", 0).put("sha256", "");
        ((ObjectNode) normalized.path("systemd")).put("label", "");
        normalized.putObject("generators");
        normalized.putObject("linkPlan");
        ((ObjectNode) normalized.path("bootState")).putObject("scriptOutputs");
        try (var input = WorkspaceCsiInstalledBytes.class.getResourceAsStream("/k2-cold-lane.json")) {
            require(input != null && normalized.equals(object(input.readNBytes(64 * 1024 + 1), 64 * 1024)));
        }
        return value;
    }

    private static boolean coldPath(String name) {
        return name.length() <= 2048 && name.startsWith("/") && !name.endsWith("/")
                && !name.contains("//") && !name.contains("/./") && !name.contains("/../")
                && !name.endsWith("/.") && !name.endsWith("/..")
                && !name.contains("\0") && !name.contains("\r") && !name.contains("\n");
    }

    private static String resolveCold(String name, JsonNode links) {
        require(coldPath(name));
        for (int count = 0; count <= 40; count++) {
            String[] parts = name.substring(1).split("/");
            String prefix = "";
            boolean changed = false;
            for (int i = 0; i < parts.length; i++) {
                prefix += "/" + parts[i];
                if (!links.has(prefix)) {
                    continue;
                }
                String target = text(links, prefix);
                if (!target.startsWith("/")) {
                    target = prefix.substring(0, prefix.lastIndexOf('/') + 1) + target;
                }
                for (int j = i + 1; j < parts.length; j++) {
                    target += "/" + parts[j];
                }
                var normalized = new java.util.ArrayDeque<String>();
                for (String part : target.split("/")) {
                    if (part.equals("..")) {
                        if (!normalized.isEmpty()) {
                            normalized.removeLast();
                        }
                    } else if (!part.isEmpty() && !part.equals(".")) {
                        normalized.addLast(part);
                    }
                }
                name = "/" + String.join("/", normalized);
                changed = true;
                break;
            }
            if (!changed) {
                return name;
            }
        }
        throw new IllegalArgumentException("Invalid cold dependency alias cycle");
    }

    private static void cold(Path directory, JsonNode pins, JsonNode cold) throws IOException {
        JsonNode target = object(pinned(directory, pins, "target.json", 32 * 1024), 32 * 1024);
        closed(target, Set.of("format", "architecture", "coldBootstrapSha256", "hostExecutables", "snapshotRoot",
                "podSlicePrefix", "apparmorExportRoot", "systemBus", "volumeSerialPath", "roleConfigPaths",
                "sandboxNetworkNamespaceSource", "rootfsMounts", "oldRootPath", "hugepageSizes"));
        require("qwen-k2-profile-target/3".equals(text(target, "format"))
                && text(pins.path("cold-bootstrap.json"), "sha256").equals(text(target, "coldBootstrapSha256"))
                && text(cold, "architecture").equals(text(target, "architecture")));
        JsonNode systemd = cold.path("systemd");
        closed(systemd, Set.of("path", "bytes", "sha256", "label"));
        positive(systemd, "bytes", 128 * 1024 * 1024);
        JsonNode hosts = target.path("hostExecutables");
        closed(hosts, Set.of("runtime", "kubelet", "registrar", "plugin", "systemd"));
        for (String field : Set.of("path", "sha256", "label")) {
            require(text(systemd, field).equals(text(hosts.path("systemd"), field)));
        }
        JsonNode bus = target.path("systemBus");
        closed(bus, Set.of("socket", "privateSocket", "label", "executable"));
        closed(bus.path("executable"), Set.of("path", "sha256"));
        require(text(bus.path("executable"), "path").startsWith("/")
                && text(bus.path("executable"), "sha256").matches("[0-9a-f]{64}"));
        var labels = new java.util.HashSet<String>();
        for (JsonNode host : hosts) {
            closed(host, Set.of("path", "sha256", "label"));
            require(labels.add(text(host, "label")));
        }
        require(labels.add(text(bus, "label")) && !labels.contains("unconfined"));
    }

    private static CsiInstalledByteObservation observation(String role, String installation, String architecture,
            String packed, int packedBytes, String path, byte[] configuration, byte[] shim, byte[] unit) {
        return new CsiInstalledByteObservation("qwen-k2-installed-byte-observation/1", role, installation, architecture,
                packed, packedBytes, path, DigestUtils.sha256Hex(configuration), DigestUtils.sha256Hex(shim),
                "/etc/systemd/system/" + ("source".equals(role) ? "qwen-k2-node-source.service" : "qwen-k2-runtime-gateway.service"),
                DigestUtils.sha256Hex(unit));
    }

    private static byte[] pinned(Path directory, JsonNode pins, String name, int limit) throws IOException {
        int expected = positive(pins.path(name), "bytes", limit);
        byte[] bytes = read(directory.resolve(name), limit);
        require(bytes.length == expected && DigestUtils.sha256Hex(bytes).equals(text(pins.path(name), "sha256")));
        return bytes;
    }

    private static byte[] read(Path path, int limit) throws IOException {
        try (var input = Files.newInputStream(path, LinkOption.NOFOLLOW_LINKS)) {
            byte[] bytes = input.readNBytes(limit + 1);
            require(bytes.length > 0 && bytes.length <= limit);
            return bytes;
        }
    }

    private static String text(JsonNode value, String name) {
        require(value.path(name).isTextual() && !value.path(name).textValue().isEmpty());
        return value.path(name).textValue();
    }

    private static int positive(JsonNode value, String name, int maximum) {
        var field = value.path(name);
        require(field.isIntegralNumber() && field.canConvertToInt() && field.intValue() > 0 && field.intValue() <= maximum);
        return field.intValue();
    }
}
