package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.store.WorkspaceCsiRegistration;
import com.fasterxml.jackson.core.StreamReadFeature;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.json.JsonMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

/** Offline renderer; output must be reviewed and validated against the target API. */
public final class WorkspaceCsiProtectionMain {
    private WorkspaceCsiProtectionMain() {
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 3) {
            throw new IllegalArgumentException("Usage: <reviewed-registration-json> <policy-name> <binding-name>");
        }
        for (int index = 1; index < 3; index++) {
            if (args[index].length() > 253) {
                throw new IllegalArgumentException("Protection names must be DNS subdomains");
            }
            for (String label : args[index].split("\\.", -1)) {
                if (!label.matches("[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")) {
                    throw new IllegalArgumentException("Protection names must be DNS subdomains");
                }
            }
        }
        var json = JsonMapper.builder().enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
                .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();
        WorkspaceCsiRegistration registration;
        try (var input = Files.newInputStream(Path.of(args[0]))) {
            byte[] bytes = input.readNBytes(16 * 1024 + 1);
            if (bytes.length > 16 * 1024) {
                throw new IllegalArgumentException();
            }
            registration = json.readValue(bytes, WorkspaceCsiRegistration.class);
        } catch (Exception error) {
            throw new IllegalArgumentException("CSI registration could not be read");
        }
        System.out.println(json.writeValueAsString(Map.of("apiVersion", "v1", "kind", "List", "items", List.of(
                WorkspaceCsiResourceGuard.policy(registration, args[1]), WorkspaceCsiResourceGuard.binding(args[1], args[2])))));
    }
}
