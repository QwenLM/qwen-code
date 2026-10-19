package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.runtimebroker.CsiCreationContractFixture;
import com.alibaba.qwen.code.runtimebroker.CsiNodeSourceJournal;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.math.BigInteger;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class WorkspaceCsiNodeSourceMainTest {
    private final ObjectMapper json = new ObjectMapper();
    @TempDir
    Path directory;

    @Test
    void nodeRequestUsesReviewedContractAndArtifactPins() throws Exception {
        var files = files(CsiCreationContractFixture.bytes());
        var result = WorkspaceCsiNodeSourceMain.nodeRequest(files.deployment(), observed(files));
        var inputs = result.node().birthInputs();
        assertThat(inputs.shimSha256()).isEqualTo("3".repeat(64));
        assertThat(inputs.runcSha256()).isEqualTo("4".repeat(64));
        assertThat(inputs.sandboxImageSha256()).isEqualTo("5".repeat(64));
        assertThat(Base64.getDecoder().decode(inputs.creationContract())).isEqualTo(CsiCreationContractFixture.bytes());
        assertThat(result.node().identity()).isEqualTo(observed(files).source());
        assertThat(result.node().installedBytes()).isEqualTo(files.reviewed());
    }

    @Test
    void fullContractSurvivesThePersistedConfigurationBoundary() throws Exception {
        var contract = (ObjectNode) json.readTree(CsiCreationContractFixture.bytes());
        var env = ((ObjectNode) contract.path("worker")).putArray("env");
        for (int index = 0; index < 128; index++) {
            env.add("VALUE_" + index + "=" + "x".repeat(90));
        }
        byte[] raw = json.writeValueAsBytes(contract);
        var files = files(raw);
        var request = WorkspaceCsiNodeSourceMain.nodeRequest(files.deployment(), observed(files));
        var scope = new CsiNodeSourceJournal.Scope("arm", "namespace", "pod", "", "", "driver", "volume", "pv", "pvc", "", "binding", "");
        var configuration = new WorkspaceCsiNodeSourceStore.Configuration(request.node(), "6".repeat(64), scope);
        String encoded = json.writeValueAsString(configuration);
        assertThat(encoded.length()).isGreaterThan(16 * 1024).isLessThan(WorkspaceCsiNodeSourceStore.CONFIGURATION_LIMIT);
        var restored = WorkspaceCsiNodeSourceStore.decode(encoded, WorkspaceCsiNodeSourceStore.Configuration.class);
        assertThat(restored).isEqualTo(configuration);
        assertThat(Base64.getDecoder().decode(restored.node().birthInputs().creationContract())).isEqualTo(raw);
        assertThat(encoded).doesNotContain("client.p12", "password", "ca.pem", "synthetic-key", "gatewayClientKey");
    }

    @ParameterizedTest
    @ValueSource(strings = {"missing-contract", "alias-contract", "non-string-contract", "invalid-contract", "unknown", "runtime", "node"})
    void unsupportedReviewedInputsCannotProduceNodeRequest(String fault) throws Exception {
        var files = files(CsiCreationContractFixture.bytes());
        switch (fault) {
            case "missing-contract" -> files.shim().remove("creationContract");
            case "alias-contract" -> files.shim().set("CreationContract", files.shim().remove("creationContract"));
            case "non-string-contract" -> files.shim().put("creationContract", 42);
            case "invalid-contract" -> files.shim().put("creationContract", "e30=");
            case "unknown" -> files.source().put("qualified", "true");
            case "runtime" -> files.source().put("runtimeDigest", "f".repeat(64));
            case "node" -> files.source().put("nodeUid", "foreign-node");
            default -> throw new AssertionError(fault);
        }
        write(files);
        assertThatThrownBy(() -> WorkspaceCsiNodeSourceMain.nodeRequest(files.deployment(), observed(files))).isInstanceOf(RuntimeException.class);
    }

    @ParameterizedTest
    @ValueSource(strings = {"installation.json", "profile-candidate.json", "profile-compile.json", "source-config.installed.json",
        "gateway-config.json", "shim.json", "qwen-k2-node-source.service", "qwen-k2-runtime-gateway.service",
        "host-policies.json", "host-runtime.rules", "host-kubelet.rules", "host-registrar.rules", "host-plugin.rules",
        "host-systemd.rules", "host-system-bus.rules", "cold-bootstrap.json"})
    void independentlyChangedReviewedBytesCannotBeLearnedFromTheStream(String name) throws Exception {
        var files = files(CsiCreationContractFixture.bytes());
        var before = observed(files);
        Files.writeString(files.deployment().installedArtifacts().resolve(name), "\n", java.nio.file.StandardOpenOption.APPEND);
        assertThatThrownBy(() -> WorkspaceCsiNodeSourceMain.nodeRequest(files.deployment(), before)).isInstanceOf(RuntimeException.class);
        assertThat(before.source()).isEqualTo(observed(files).source());
    }

    @ParameterizedTest
    @ValueSource(strings = {"host-version", "nested-pin", "missing-base", "extra-base", "oversized-base",
        "old-candidate", "old-installation"})
    void outerPinsCannotRepairUnsupportedHostMetadata(String fault) throws Exception {
        var inputs = files(CsiCreationContractFixture.bytes());
        Path root = inputs.deployment().installedArtifacts();
        byte[] source = Files.readAllBytes(inputs.deployment().sourceConfiguration());
        byte[] shim = Files.readAllBytes(inputs.deployment().shimConfiguration());
        assertThat(WorkspaceCsiInstalledBytes.read(root, source, shim)).isEqualTo(inputs.reviewed());
        var host = (ObjectNode) json.readTree(Files.readAllBytes(root.resolve("host-policies.json")));
        var hostPins = (ObjectNode) host.path("files");
        switch (fault) {
            case "host-version" -> host.put("format", "qwen-k2-host-policies/0");
            case "nested-pin" -> ((ObjectNode) hostPins.path("host-runtime.rules")).put("sha256", "0".repeat(64));
            case "missing-base" -> hostPins.remove("host-runtime.rules");
            case "extra-base" -> hostPins.set("../foreign.rules", hostPins.path("host-runtime.rules"));
            case "oversized-base" -> Files.write(root.resolve("host-runtime.rules"), new byte[1024 * 1024 + 1]);
        }
        Files.write(root.resolve("host-policies.json"), json.writeValueAsBytes(host));
        var candidate = (ObjectNode) json.readTree(Files.readAllBytes(root.resolve("profile-candidate.json")));
        if (fault.equals("old-candidate")) {
            candidate.put("format", "qwen-k2-profile-candidate/1");
        }
        var profilePins = (ObjectNode) candidate.path("files");
        for (String name : List.of("host-policies.json", "host-runtime.rules")) {
            byte[] raw = Files.readAllBytes(root.resolve(name));
            profilePins.putObject(name).put("bytes", raw.length).put("sha256", hash(raw));
        }
        Files.write(root.resolve("profile-candidate.json"), json.writeValueAsBytes(candidate));
        var compilation = (ObjectNode) json.readTree(Files.readAllBytes(root.resolve("profile-compile.json")));
        compilation.put("profileCandidateSha256", hash(Files.readAllBytes(root.resolve("profile-candidate.json"))));
        Files.write(root.resolve("profile-compile.json"), json.writeValueAsBytes(compilation));
        var manifest = (ObjectNode) json.readTree(Files.readAllBytes(root.resolve("installation.json")));
        if (fault.equals("old-installation")) {
            manifest.put("format", "qwen-k2-installed-artifacts/1");
        }
        var pins = (ObjectNode) manifest.path("files");
        for (String name : List.of("host-policies.json", "host-runtime.rules", "profile-candidate.json", "profile-compile.json")) {
            byte[] raw = Files.readAllBytes(root.resolve(name));
            pins.putObject(name).put("bytes", raw.length).put("sha256", hash(raw));
        }
        Files.write(root.resolve("installation.json"), json.writeValueAsBytes(manifest));
        assertThatThrownBy(() -> WorkspaceCsiInstalledBytes.read(root, source, shim)).isInstanceOf(RuntimeException.class);
    }

    @Test
    void independentColdLaneResourceMatchesTheReviewedGoLane() throws Exception {
        try (var input = WorkspaceCsiInstalledBytes.class.getResourceAsStream("/k2-cold-lane.json")) {
            assertThat(input).isNotNull();
            assertThat(input.readAllBytes()).isEqualTo(Files.readAllBytes(
                    Path.of("../k2-node-evidence/internal/artifactset/cold-lane.json")));
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"cold-version", "missing-field", "null-state", "null-rootfs", "null-core", "missing-core",
        "extra-field", "helper", "core", "argv", "alias", "missing-script", "bad-generator", "target-version",
        "target-cold", "systemd", "bus-executable", "shared-label", "unclean-script-path"})
    void repairedOuterPinsCannotChangeTheColdLaneOrItsTarget(String fault) throws Exception {
        var inputs = files(CsiCreationContractFixture.bytes());
        Path root = inputs.deployment().installedArtifacts();
        byte[] source = Files.readAllBytes(inputs.deployment().sourceConfiguration());
        byte[] shim = Files.readAllBytes(inputs.deployment().shimConfiguration());
        var cold = (ObjectNode) json.readTree(Files.readAllBytes(root.resolve("cold-bootstrap.json")));
        var target = (ObjectNode) json.readTree(Files.readAllBytes(root.resolve("target.json")));
        switch (fault) {
            case "cold-version" -> cold.put("format", "qwen-k2-cold-bootstrap/0");
            case "missing-field" -> cold.remove("kernel");
            case "null-state" -> cold.putNull("bootState");
            case "null-rootfs" -> cold.putNull("rootfsPlan");
            case "null-core" -> ((ObjectNode) cold.path("bootState")).putNull("coreSoft");
            case "missing-core" -> ((ObjectNode) cold.path("bootState")).remove("coreSoft");
            case "extra-field" -> cold.put("qualified", true);
            case "helper" -> ((ObjectNode) cold.path("bootState").path("helpers")).put("/proc/sys/kernel/modprobe", "/sbin/modprobe\n");
            case "core" -> ((ObjectNode) cold.path("bootState")).put("coreHard", 1);
            case "argv" -> ((ObjectNode) cold.path("rootfsPlan")).putArray("argv").add("/sbin/init").add("rescue");
            case "alias" -> ((ObjectNode) cold.path("linkPlan")).put("/lib", "foreign");
            case "unclean-script-path" -> ((ObjectNode) cold.path("bootState").path("scriptOutputs")).set("/scripts/./ORDER",
                    cold.path("bootState").path("scriptOutputs").path("/init"));
            case "missing-script" -> ((ObjectNode) cold.path("bootState").path("scriptOutputs")).remove("/init");
            case "bad-generator" -> ((ObjectNode) cold.path("generators")).put("cold_boot.py", "not-a-digest");
            case "target-version" -> target.put("format", "qwen-k2-profile-target/2");
            case "systemd" -> ((ObjectNode) target.path("hostExecutables").path("systemd")).put("sha256", "0".repeat(64));
            case "bus-executable" -> ((ObjectNode) target.path("systemBus")).remove("executable");
            case "shared-label" -> ((ObjectNode) target.path("systemBus")).put("label",
                    target.path("hostExecutables").path("systemd").path("label").textValue());
        }
        byte[] coldRaw = json.writeValueAsBytes(cold);
        Files.write(root.resolve("cold-bootstrap.json"), coldRaw);
        target.put("coldBootstrapSha256", fault.equals("target-cold") ? "0".repeat(64) : hash(coldRaw));
        Files.write(root.resolve("target.json"), json.writeValueAsBytes(target));
        var profile = (ObjectNode) json.readTree(Files.readAllBytes(root.resolve("profile-candidate.json")));
        var profilePins = (ObjectNode) profile.path("files");
        for (String name : List.of("cold-bootstrap.json", "target.json")) {
            byte[] raw = Files.readAllBytes(root.resolve(name));
            profilePins.putObject(name).put("bytes", raw.length).put("sha256", hash(raw));
        }
        Files.write(root.resolve("profile-candidate.json"), json.writeValueAsBytes(profile));
        var compilation = (ObjectNode) json.readTree(Files.readAllBytes(root.resolve("profile-compile.json")));
        compilation.put("profileCandidateSha256", hash(Files.readAllBytes(root.resolve("profile-candidate.json"))));
        Files.write(root.resolve("profile-compile.json"), json.writeValueAsBytes(compilation));
        var manifest = (ObjectNode) json.readTree(Files.readAllBytes(root.resolve("installation.json")));
        var pins = (ObjectNode) manifest.path("files");
        for (String name : List.of("cold-bootstrap.json", "target.json", "profile-candidate.json", "profile-compile.json")) {
            byte[] raw = Files.readAllBytes(root.resolve(name));
            pins.putObject(name).put("bytes", raw.length).put("sha256", hash(raw));
        }
        Files.write(root.resolve("installation.json"), json.writeValueAsBytes(manifest));
        assertThatThrownBy(() -> WorkspaceCsiInstalledBytes.read(root, source, shim)).isInstanceOf(RuntimeException.class);
    }

    @Test
    void oldNodeConfigurationCannotAcquireMissingByteExpectations() throws Exception {
        var files = files(CsiCreationContractFixture.bytes());
        var request = WorkspaceCsiNodeSourceMain.nodeRequest(files.deployment(), observed(files));
        var scope = new CsiNodeSourceJournal.Scope("arm", "namespace", "pod", "", "", "driver", "volume", "pv", "pvc", "", "binding", "");
        var value = json.valueToTree(new WorkspaceCsiNodeSourceStore.Configuration(request.node(), "6".repeat(64), scope));
        ((ObjectNode) value.path("node")).remove("installedBytes");
        assertThatThrownBy(() -> WorkspaceCsiNodeSourceStore.decode(json.writeValueAsString(value), WorkspaceCsiNodeSourceStore.Configuration.class))
                .isInstanceOf(RuntimeException.class);
    }

    private record Inputs(WorkspaceCsiNodeSourceMain.Deployment deployment, ObjectNode source, ObjectNode shim,
            WorkspaceCsiNodeSourceStore.InstalledBytes reviewed) {
    }

    private Inputs files(byte[] contract) throws Exception {
        var source = json.createObjectNode();
        for (String field : List.of("certificate", "key", "authority", "driver", "journalRoot", "pluginSocket", "frontendSocket",
                "kubeletDigest", "registrarDigest", "gatewayClientCertificate", "gatewayClientKey")) {
            source.put(field, "synthetic-" + field);
        }
        source.put("listen", "source.example:9443").put("coordinatorPrincipal", "spiffe://test/coordinator")
                .put("nodeUid", "node-uid").put("pluginDigest", "2".repeat(64)).put("runtimeDigest", "1".repeat(64))
                .put("gatewayUrl", "https://gateway.example:9444").put("gatewayPrincipal", "spiffe://test/gateway")
                .put("kubeletDigest", "a".repeat(64)).put("registrarDigest", "b".repeat(64))
                .put("workerPolicySha256", hash("explicit synthetic packed data".getBytes(java.nio.charset.StandardCharsets.UTF_8))).put("sandboxImageSha256", "5".repeat(64));
        var shim = json.createObjectNode();
        shim.putObject("inputs").put("bundleRoot", "/run/containerd/io.containerd.runtime.v2.task/k8s.io")
                .put("inputRoot", "/var/lib/qwen-k2/inputs").put("runcPath", "/opt/qwen-k2/bin/runc")
                .put("runcRoot", "/run/qwen-k2/runc").put("runcSha256", "4".repeat(64));
        shim.put("sourceSocket", "/run/qwen-k2/source/birth.sock").put("sourceSha256", "8".repeat(64))
                .put("shimPath", "/opt/qwen-k2/bin/containerd-shim-qwen-k2-v1").put("shimSha256", "3".repeat(64))
                .put("socketRoot", "/run/qwen-k2/shims").put("containerdGrpc", "/run/containerd/containerd.sock")
                .put("containerdTtrpc", "/run/containerd/containerd.sock.ttrpc")
                .put("creationContract", Base64.getEncoder().encodeToString(contract));
        var client = new WorkspaceCsiNodeSourceMain.Request(URI.create("https://source.example:9443"), "spiffe://test/source",
                "spiffe://test/coordinator", directory.resolve("client.p12"), directory.resolve("password"), directory.resolve("ca.pem"));
        var deployment = new WorkspaceCsiNodeSourceMain.Deployment("node", client, directory.resolve("source.json"), directory.resolve("shim.json"), directory.resolve("metadata"));
        var reviewed = metadata(deployment.installedArtifacts(), json.writeValueAsBytes(source), json.writeValueAsBytes(shim));
        var result = new Inputs(deployment, source, shim, reviewed);
        write(result);
        return result;
    }

    private void write(Inputs inputs) throws Exception {
        Files.write(inputs.deployment().sourceConfiguration(), json.writeValueAsBytes(inputs.source()));
        Files.write(inputs.deployment().shimConfiguration(), json.writeValueAsBytes(inputs.shim()));
    }

    private static CsiNodeSourceJournal.Stream observed(Inputs files) {
        var source = new CsiNodeSourceJournal.SourceIdentity("node-uid", "boot-id", "1".repeat(64), BigInteger.ONE,
                10, "9".repeat(32), "2".repeat(64), BigInteger.TWO, 20, files.reviewed().source(), files.reviewed().gateway());
        return new CsiNodeSourceJournal.Stream("0".repeat(32), source, new CsiNodeSourceJournal.Cursor(1, "a".repeat(64)), "b".repeat(64), List.of());
    }

    // These are explicitly synthetic reviewed metadata bytes, never a parser or installation result.
    private WorkspaceCsiNodeSourceStore.InstalledBytes metadata(Path root, byte[] source, byte[] shim) throws Exception {
        var sourceValue = json.readTree(source);
        var shimValue = json.readTree(shim);
        var files = new java.util.LinkedHashMap<String, byte[]>();
        files.put("source-config.installed.json", source);
        files.put("source-config.json", source);
        files.put("shim.json", shim);
        files.put("gateway-config.json", "{\"synthetic\":\"gateway config bytes\"}".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        files.put("qwen-k2-node-source.service", "ExecStart=/opt/qwen-k2/bin/k2-node-evidence source /etc/qwen-k2/source.json\n".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        files.put("qwen-k2-runtime-gateway.service", "ExecStart=/opt/qwen-k2/bin/k2-node-evidence gateway /etc/qwen-k2/gateway.json\n".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        files.put("packed.bin", "explicit synthetic packed data".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        for (String name : List.of("features", "qwen-k2-profiles", "target.json", "runtime.json", "worker-catalog.json", "sandbox-catalog.json")) {
            files.put(name, ("explicit synthetic " + name).getBytes(java.nio.charset.StandardCharsets.UTF_8));
        }
        byte[] coldRaw = Files.readAllBytes(Path.of("../k2-node-evidence/internal/artifactset/testdata/cold-bootstrap.fixture.json"));
        files.put("cold-bootstrap.json", coldRaw);
        var cold = json.readTree(coldRaw);
        var target = json.createObjectNode().put("format", "qwen-k2-profile-target/3").put("architecture", "amd64")
                .put("coldBootstrapSha256", hash(coldRaw));
        for (String name : List.of("snapshotRoot", "podSlicePrefix", "apparmorExportRoot", "volumeSerialPath",
                "sandboxNetworkNamespaceSource", "oldRootPath")) {
            target.put(name, "/explicit-synthetic-input");
        }
        target.putObject("roleConfigPaths");
        target.putObject("rootfsMounts");
        target.putArray("hugepageSizes");
        var hostValues = target.putObject("hostExecutables");
        for (String role : List.of("runtime", "kubelet", "registrar", "plugin", "systemd")) {
            var host = hostValues.putObject(role);
            for (String field : List.of("path", "sha256", "label")) {
                host.put(field, role.equals("systemd") ? cold.path("systemd").path(field).textValue()
                        : field.equals("sha256") ? "e".repeat(64) : field.equals("path") ? "/usr/bin/" + role : "host-" + role);
            }
        }
        var bus = target.putObject("systemBus").put("socket", "/run/dbus/system_bus_socket")
                .put("privateSocket", "/run/systemd/private").put("label", "host-bus");
        bus.putObject("executable").put("path", "/usr/bin/dbus-daemon").put("sha256", "e".repeat(64));
        files.put("target.json", json.writeValueAsBytes(target));
        files.put("creation-contract.json", Base64.getDecoder().decode(shimValue.path("creationContract").textValue()));
        var hostPolicies = json.createObjectNode().put("format", "qwen-k2-host-policies/1");
        var hostFiles = hostPolicies.putObject("files");
        for (String role : List.of("runtime", "kubelet", "registrar", "plugin", "systemd", "system-bus")) {
            String name = "host-" + role + ".rules";
            byte[] raw = "  \"/explicit-inert-base-only\" r,\n".getBytes(java.nio.charset.StandardCharsets.UTF_8);
            files.put(name, raw);
            hostFiles.putObject(name).put("bytes", raw.length).put("sha256", hash(raw));
        }
        files.put("host-policies.json", json.writeValueAsBytes(hostPolicies));
        var artifacts = json.createObjectNode().put("format", "qwen-k2-pre-exec-artifacts/2");
        var executable = artifacts.putObject("artifacts");
        for (String role : List.of("source", "shim", "runc")) {
            String sha = role.equals("runc") ? shimValue.path("inputs").path("runcSha256").textValue() : shimValue.path(role + "Sha256").textValue();
            executable.putObject(role).put("sha256", sha).put("bytes", 64).put("architecture", "amd64");
        }
        artifacts.put("creationContractSha256", hash(files.get("creation-contract.json")))
                .put("sandboxImageSha256", sourceValue.path("sandboxImageSha256").textValue()).put("workerImageSha256", "6".repeat(64));
        artifacts.putObject("catalogues");
        artifacts.putObject("generators");
        files.put("artifact-manifest.json", json.writeValueAsBytes(artifacts));
        var candidate = json.createObjectNode().put("format", "qwen-k2-profile-candidate/3")
                .put("artifactManifestSha256", hash(files.get("artifact-manifest.json"))).put("shimConfigurationSha256", hash(shim));
        candidate.putObject("roleConfigPaths").put("source", "/etc/qwen-k2/source.json").put("gateway", "/etc/qwen-k2/gateway.json");
        candidate.putArray("boundaries").add("synthetic data only, no qualification");
        candidate.putObject("generators");
        var profileFiles = candidate.putObject("files");
        for (String name : List.of("source-config.json", "gateway-config.json", "target.json", "runtime.json", "creation-contract.json",
                "qwen-k2-node-source.service", "qwen-k2-runtime-gateway.service", "qwen-k2-profiles", "host-policies.json",
                "host-runtime.rules", "host-kubelet.rules", "host-registrar.rules", "host-plugin.rules",
                "host-systemd.rules", "host-system-bus.rules", "cold-bootstrap.json")) {
            profileFiles.putObject(name).put("bytes", files.get(name).length).put("sha256", hash(files.get(name)));
        }
        files.put("profile-candidate.json", json.writeValueAsBytes(candidate));
        var compilation = json.createObjectNode().put("format", "qwen-k2-profile-compile/2");
        compilation.putArray("command").add("not-executed-parser-placeholder");
        compilation.put("profileCandidateSha256", hash(files.get("profile-candidate.json"))).put("parserSha256", "0".repeat(64))
                .put("featuresSha256", hash(files.get("features"))).put("sourceSha256", hash(files.get("qwen-k2-profiles")))
                .put("parserConfigurationSha256", "0".repeat(64)).put("generatorSha256", "0".repeat(64)).put("exitCode", 0)
                .put("packedBytes", files.get("packed.bin").length).put("packedSha256", hash(files.get("packed.bin")));
        files.put("profile-compile.json", json.writeValueAsBytes(compilation));
        var manifest = json.createObjectNode().put("format", "qwen-k2-installed-artifacts/3");
        var pins = manifest.putObject("files");
        for (var entry : files.entrySet()) {
            pins.putObject(entry.getKey()).put("bytes", entry.getValue().length).put("sha256", hash(entry.getValue()));
        }
        byte[] manifestRaw = json.writeValueAsBytes(manifest);
        Files.createDirectory(root);
        Files.write(root.resolve("installation.json"), manifestRaw);
        for (var entry : files.entrySet()) {
            Files.write(root.resolve(entry.getKey()), entry.getValue());
        }
        var sourceExpected = expected("source", manifestRaw, files, sourceValue.path("workerPolicySha256").textValue());
        var gatewayExpected = expected("gateway", manifestRaw, files, sourceValue.path("workerPolicySha256").textValue());
        return new WorkspaceCsiNodeSourceStore.InstalledBytes(sourceExpected, gatewayExpected,
                sourceValue.path("kubeletDigest").textValue(), sourceValue.path("registrarDigest").textValue());
    }

    private static com.alibaba.qwen.code.runtimebroker.CsiInstalledByteObservation expected(String role, byte[] manifest,
            java.util.Map<String, byte[]> files, String packed) throws Exception {
        String configuration = role.equals("source") ? "source-config.installed.json" : "gateway-config.json";
        String unit = role.equals("source") ? "qwen-k2-node-source.service" : "qwen-k2-runtime-gateway.service";
        return new com.alibaba.qwen.code.runtimebroker.CsiInstalledByteObservation("qwen-k2-installed-byte-observation/1", role,
                hash(manifest), "amd64", packed, files.get("packed.bin").length, "/etc/qwen-k2/" + role + ".json",
                hash(files.get(configuration)), hash(files.get("shim.json")), "/etc/systemd/system/" + unit, hash(files.get(unit)));
    }

    private static String hash(byte[] raw) throws Exception {
        return java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(raw));
    }
}
