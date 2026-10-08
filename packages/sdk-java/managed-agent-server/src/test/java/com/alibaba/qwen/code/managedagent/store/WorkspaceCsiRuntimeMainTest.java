package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.service.WorkspaceCsiResourceGuard;
import com.fasterxml.jackson.core.StreamReadFeature;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class WorkspaceCsiRuntimeMainTest {
    private final ObjectMapper json = JsonMapper.builder().enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();
    @TempDir Path directory;

    @Test
    void readsReviewedOriginalRequestAndRefusesAmbiguousOrOversizedConfiguration() throws Exception {
        var registration = new WorkspaceCsiRegistration("tenant", "storage", "cluster", "runtime", "pvc", "pvc-uid",
                "pv", "pv-uid", "diskplugin.csi.alibabacloud.com", "volume", "backend", "serial", "/workspace", 1);
        String uid = UUID.randomUUID().toString();
        var request = new WorkspaceCsiRuntimeMain.Request(registration, UUID.randomUUID().toString(), "a".repeat(64),
                "registry.example/worker@sha256:" + "b".repeat(64), List.of("node", "/opt/worker.js"), List.of(),
                new WorkspaceCsiResourceGuard.ProtectionIdentity(uid, "protect", uid, 1, "protect-binding", uid, 1));
        Path path = directory.resolve("request.json");
        String body = json.writeValueAsString(request);
        Files.writeString(path, body);
        assertThat(WorkspaceCsiRuntimeMain.readRequest(path, json)).isEqualTo(request);
        for (String rejected : List.of(body + " {}", body.replaceFirst("\\{", "{\"unexpected\":true,"),
                body.replaceFirst("\\{", "{\"sessionId\":\"foreign\","), "null", " ".repeat(65537))) {
            Files.writeString(path, rejected);
            assertThatThrownBy(() -> WorkspaceCsiRuntimeMain.readRequest(path, json))
                    .isInstanceOf(IllegalArgumentException.class).hasMessage("CSI operator request could not be read");
        }
    }

    @Test
    void refusesInvalidCommandBeforeReadingCredentialsOrStartingServer() {
        for (String[] args : List.of(new String[] {}, new String[] {"create", "missing", "43190"},
                new String[] {"serve", "missing", "0"}, new String[] {"serve", "missing", "65536"})) {
            assertThatThrownBy(() -> WorkspaceCsiRuntimeMain.run(args)).isInstanceOf(IllegalArgumentException.class);
        }
    }
}
