package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.runtimebroker.transport.CsiNodeSourceClient;
import com.alibaba.qwen.code.runtimebroker.transport.CsiNodeSourceJournal;
import com.fasterxml.jackson.core.StreamReadFeature;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.json.JsonMapper;

import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Set;

/** Read-only source inspection for the private operator; successful parsing is not release qualification. */
public final class WorkspaceCsiNodeSourceMain {
    private WorkspaceCsiNodeSourceMain() {
    }

    public record Request(URI sourceOrigin, String sourcePrincipal, String coordinatorPrincipal,
            Path clientStore, Path passwordFile, Path caFile) {
    }

    public record Deployment(String nodeName, Request client, Path sourceConfiguration, Path shimConfiguration,
            Path installedArtifacts) { }

    public static void main(String[] args) {
        try {
            run(args);
        } catch (Exception failure) {
            System.err.println("Authenticated CSI node source inspection failed.");
            System.exit(1);
        }
    }

    static void run(String[] args) throws Exception {
        if (args.length != 2 || !Set.of("source-status", "node-config").contains(args[0])) {
            throw new IllegalArgumentException("Usage: <source-status|node-config> <reviewed-client-or-deployment-json>");
        }
        var json = JsonMapper.builder().enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
                .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();
        byte[] bytes = read(Path.of(args[1]).toAbsolutePath().normalize(), 16 * 1024);
        Deployment deployment = "node-config".equals(args[0])
                ? WorkspaceCsiSourceJson.typedObject(bytes, 16 * 1024, Deployment.class) : null;
        var request = deployment == null ? json.readValue(bytes, Request.class) : deployment.client();
        WorkspaceCsiSourceJson.require(request != null);
        try (var client = new CsiNodeSourceClient(request.sourceOrigin(), request.sourcePrincipal(),
                request.coordinatorPrincipal(), request.clientStore(), request.passwordFile(), request.caFile())) {
            var observed = client.observe();
            System.out.println(json.writeValueAsString(deployment == null ? observed : nodeRequest(deployment, observed)));
        }
    }

    /** Uses reviewed deployment inputs for expectations, never hashes copied from observed births. */
    static WorkspaceCsiRuntimeMain.NodeRequest nodeRequest(Deployment deployment, CsiNodeSourceJournal.Stream observed) throws java.io.IOException {
        WorkspaceCsiSourceJson.require(deployment != null && deployment.client() != null && observed != null);
        byte[] sourceRaw = read(deployment.sourceConfiguration(), 32 * 1024);
        var source = WorkspaceCsiSourceJson.object(sourceRaw, 32 * 1024);
        WorkspaceCsiSourceJson.closed(source, Set.of("listen", "certificate", "key", "authority", "coordinatorPrincipal",
                "nodeUid", "driver", "journalRoot", "pluginSocket", "pluginDigest", "frontendSocket", "kubeletDigest",
                "registrarDigest", "gatewayUrl", "gatewayPrincipal", "runtimeDigest", "gatewayClientCertificate",
                "gatewayClientKey", "workerPolicySha256", "sandboxImageSha256"));
        byte[] shimRaw = read(deployment.shimConfiguration(), 32 * 1024);
        var shim = WorkspaceCsiSourceJson.object(shimRaw, 32 * 1024);
        WorkspaceCsiSourceJson.closed(shim, Set.of("inputs", "sourceSocket", "sourceSha256", "shimPath", "shimSha256",
                "socketRoot", "containerdGrpc", "containerdTtrpc", "creationContract"));
        var inputs = shim.path("inputs");
        WorkspaceCsiSourceJson.closed(inputs, Set.of("bundleRoot", "inputRoot", "runcPath", "runcRoot", "runcSha256"));
        for (var value : source) {
            WorkspaceCsiSourceJson.require(value.isTextual() && !value.textValue().isEmpty());
        }
        for (String name : Set.of("sourceSocket", "sourceSha256", "shimPath", "shimSha256", "socketRoot", "containerdGrpc", "containerdTtrpc")) {
            WorkspaceCsiSourceJson.require(shim.path(name).isTextual() && !shim.path(name).textValue().isEmpty());
        }
        for (var value : inputs) {
            WorkspaceCsiSourceJson.require(value.isTextual() && !value.textValue().isEmpty());
        }
        WorkspaceCsiSourceJson.require(WorkspaceCsiNodeSourceStore.matchesFixedBirthPolicy(inputs));
        var identity = observed.source();
        var client = deployment.client();
        WorkspaceCsiSourceJson.require(identity != null && identity.nodeUid().equals(source.path("nodeUid").textValue())
                && identity.runtimeDigest().equals(source.path("runtimeDigest").textValue())
                && identity.pluginDigest().equals(source.path("pluginDigest").textValue())
                && client.sourceOrigin().toString().equals("https://" + source.path("listen").textValue())
                && client.coordinatorPrincipal().equals(source.path("coordinatorPrincipal").textValue())
                && !client.coordinatorPrincipal().equals(client.sourcePrincipal())
                && !client.coordinatorPrincipal().equals(source.path("gatewayPrincipal").textValue())
                && "/opt/qwen-k2/bin/containerd-shim-qwen-k2-v1".equals(shim.path("shimPath").textValue())
                && "/run/qwen-k2/source/birth.sock".equals(shim.path("sourceSocket").textValue())
                && "/run/qwen-k2/shims".equals(shim.path("socketRoot").textValue())
                && "/run/containerd/containerd.sock".equals(shim.path("containerdGrpc").textValue())
                && "/run/containerd/containerd.sock.ttrpc".equals(shim.path("containerdTtrpc").textValue())
                && shim.path("sourceSha256").textValue().matches("[0-9a-f]{64}")
                && shim.path("shimSha256").textValue().matches("[0-9a-f]{64}")
                && inputs.path("runcSha256").textValue().matches("[0-9a-f]{64}")
                && source.path("sandboxImageSha256").textValue().matches("[0-9a-f]{64}"));
        var birthInputs = new WorkspaceCsiNodeSourceStore.BirthInputs(shim.path("shimSha256").textValue(),
                inputs.path("runcSha256").textValue(), source.path("sandboxImageSha256").textValue(), shim.path("creationContract").textValue());
        var installedBytes = WorkspaceCsiInstalledBytes.read(deployment.installedArtifacts(), sourceRaw, shimRaw);
        WorkspaceCsiSourceJson.require(installedBytes.source().equals(identity.sourceArtifacts())
                && installedBytes.gateway().equals(identity.gatewayArtifacts()));
        var node = new WorkspaceCsiNodeSourceStore.Node(deployment.nodeName(), observed.incarnation(), identity,
                client.sourceOrigin(), client.sourcePrincipal(), URI.create(source.path("gatewayUrl").textValue()),
                source.path("gatewayPrincipal").textValue(), source.path("workerPolicySha256").textValue(), birthInputs, installedBytes);
        return new WorkspaceCsiRuntimeMain.NodeRequest(node, client.coordinatorPrincipal(), client.clientStore(), client.passwordFile(), client.caFile());
    }

    private static byte[] read(Path path, int limit) throws java.io.IOException {
        WorkspaceCsiSourceJson.require(path != null && path.isAbsolute() && path.equals(path.normalize()));
        byte[] bytes;
        try (var input = Files.newInputStream(path)) {
            bytes = input.readNBytes(limit + 1);
        }
        WorkspaceCsiSourceJson.require(bytes.length > 0 && bytes.length <= limit);
        return bytes;
    }
}
