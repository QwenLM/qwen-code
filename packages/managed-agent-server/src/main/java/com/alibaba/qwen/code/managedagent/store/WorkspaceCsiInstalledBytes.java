package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.runtimebroker.CsiCreationContract;
import com.alibaba.qwen.code.runtimebroker.CsiInstalledByteObservation;
import com.fasterxml.jackson.databind.JsonNode;
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
            "host-registrar.rules", "host-plugin.rules", "host-systemd.rules", "host-system-bus.rules");
    private static final Set<String> HOST_BASES = Set.of("host-runtime.rules", "host-kubelet.rules",
            "host-registrar.rules", "host-plugin.rules", "host-systemd.rules", "host-system-bus.rules");

    private WorkspaceCsiInstalledBytes() { }

    static WorkspaceCsiNodeSourceStore.InstalledBytes read(Path directory, byte[] source, byte[] shim) throws IOException {
        require(directory != null && directory.isAbsolute() && directory.equals(directory.normalize()));
        byte[] manifestRaw = read(directory.resolve("installation.json"), 64 * 1024);
        JsonNode manifest = object(manifestRaw, 64 * 1024);
        closed(manifest, Set.of("format", "files"));
        require("qwen-k2-installed-artifacts/2".equals(text(manifest, "format")));
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
        require("qwen-k2-profile-candidate/2".equals(text(profile, "format"))
                && DigestUtils.sha256Hex(shim).equals(text(profile, "shimConfigurationSha256")));
        JsonNode paths = profile.path("roleConfigPaths");
        closed(paths, Set.of("source", "gateway"));
        JsonNode profileFiles = profile.path("files");
        Set<String> profileNames = Set.of("source-config.json", "gateway-config.json", "target.json", "runtime.json",
                "creation-contract.json", "qwen-k2-node-source.service", "qwen-k2-runtime-gateway.service", "qwen-k2-profiles",
                "host-policies.json", "host-runtime.rules", "host-kubelet.rules", "host-registrar.rules",
                "host-plugin.rules", "host-systemd.rules", "host-system-bus.rules");
        closed(profileFiles, profileNames);
        for (String name : profileNames) {
            require(profileFiles.path(name).equals(pins.path(name)));
        }
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
