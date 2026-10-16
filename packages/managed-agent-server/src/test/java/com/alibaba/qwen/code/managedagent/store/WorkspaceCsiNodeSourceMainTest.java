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
        var result = WorkspaceCsiNodeSourceMain.nodeRequest(files.deployment(), observed());
        var inputs = result.node().birthInputs();
        assertThat(inputs.shimSha256()).isEqualTo("3".repeat(64));
        assertThat(inputs.runcSha256()).isEqualTo("4".repeat(64));
        assertThat(inputs.sandboxImageSha256()).isEqualTo("5".repeat(64));
        assertThat(Base64.getDecoder().decode(inputs.creationContract())).isEqualTo(CsiCreationContractFixture.bytes());
        assertThat(result.node().identity()).isEqualTo(observed().source());
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
        var request = WorkspaceCsiNodeSourceMain.nodeRequest(files.deployment(), observed());
        var scope = new CsiNodeSourceJournal.Scope("arm", "namespace", "pod", "", "", "driver", "volume", "pv", "pvc", "", "binding", "");
        var configuration = new WorkspaceCsiNodeSourceStore.Configuration(request.node(), "6".repeat(64), scope);
        String encoded = json.writeValueAsString(configuration);
        assertThat(encoded.length()).isGreaterThan(16 * 1024).isLessThan(WorkspaceCsiNodeSourceStore.CONFIGURATION_LIMIT);
        var restored = WorkspaceCsiNodeSourceStore.decode(encoded, WorkspaceCsiNodeSourceStore.Configuration.class);
        assertThat(restored).isEqualTo(configuration);
        assertThat(Base64.getDecoder().decode(restored.node().birthInputs().creationContract())).isEqualTo(raw);
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
        assertThatThrownBy(() -> WorkspaceCsiNodeSourceMain.nodeRequest(files.deployment(), observed())).isInstanceOf(RuntimeException.class);
    }

    private record Inputs(WorkspaceCsiNodeSourceMain.Deployment deployment, ObjectNode source, ObjectNode shim) {
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
                .put("workerPolicySha256", "7".repeat(64)).put("sandboxImageSha256", "5".repeat(64));
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
        var deployment = new WorkspaceCsiNodeSourceMain.Deployment("node", client, directory.resolve("source.json"), directory.resolve("shim.json"));
        var result = new Inputs(deployment, source, shim);
        write(result);
        return result;
    }

    private void write(Inputs inputs) throws Exception {
        Files.write(inputs.deployment().sourceConfiguration(), json.writeValueAsBytes(inputs.source()));
        Files.write(inputs.deployment().shimConfiguration(), json.writeValueAsBytes(inputs.shim()));
    }

    private static CsiNodeSourceJournal.Stream observed() {
        var source = new CsiNodeSourceJournal.SourceIdentity("node-uid", "boot-id", "1".repeat(64), BigInteger.ONE,
                10, "9".repeat(32), "2".repeat(64), BigInteger.TWO, 20);
        return new CsiNodeSourceJournal.Stream("0".repeat(32), source, new CsiNodeSourceJournal.Cursor(1, "a".repeat(64)), "b".repeat(64), List.of());
    }
}
