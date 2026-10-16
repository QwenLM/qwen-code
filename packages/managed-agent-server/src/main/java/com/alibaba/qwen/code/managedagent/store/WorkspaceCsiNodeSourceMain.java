package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.runtimebroker.CsiNodeSourceClient;
import com.fasterxml.jackson.core.StreamReadFeature;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.json.JsonMapper;

import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;

/** Read-only source inspection for the private operator; successful parsing is not release qualification. */
public final class WorkspaceCsiNodeSourceMain {
    private WorkspaceCsiNodeSourceMain() {
    }

    public record Request(URI sourceOrigin, String sourcePrincipal, String coordinatorPrincipal,
            Path clientStore, Path passwordFile, Path caFile) {
    }

    public static void main(String[] args) {
        try {
            run(args);
        } catch (Exception failure) {
            System.err.println("Authenticated CSI node source inspection failed.");
            System.exit(1);
        }
    }

    static void run(String[] args) throws Exception {
        if (args.length != 2 || !"source-status".equals(args[0])) {
            throw new IllegalArgumentException("Usage: source-status <reviewed-source-client-json>");
        }
        var json = JsonMapper.builder().enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
                .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();
        byte[] bytes;
        try (var input = Files.newInputStream(Path.of(args[1]))) {
            bytes = input.readNBytes(16 * 1024 + 1);
        }
        if (bytes.length == 0 || bytes.length > 16 * 1024) {
            throw new IllegalArgumentException("A bounded reviewed source client is required");
        }
        var request = json.readValue(bytes, Request.class);
        try (var client = new CsiNodeSourceClient(request.sourceOrigin(), request.sourcePrincipal(),
                request.coordinatorPrincipal(), request.clientStore(), request.passwordFile(), request.caFile())) {
            System.out.println(json.writeValueAsString(client.observe()));
        }
    }
}
