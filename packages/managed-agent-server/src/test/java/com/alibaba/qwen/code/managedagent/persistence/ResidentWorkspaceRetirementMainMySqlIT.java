package com.alibaba.qwen.code.managedagent.persistence;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

class ResidentWorkspaceRetirementMainMySqlIT {
    @TempDir
    private Path directory;

    @Test
    void independentMaintenanceProcessesBeginInspectAndReplayWithoutStartingAWorker() throws Exception {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase()) {
            var fixture = new ResidentRetirementFixture(database.source());
            fixture.ready();
            var reservation = fixture.storage.inspect(fixture.mapping.registration());
            var json = new ObjectMapper();
            Path request = directory.resolve("request.json");
            Files.writeString(request, json.writeValueAsString(fixture.request));
            String config = json.writeValueAsString(Map.of("spring", Map.of("datasource", Map.of(
                    "url", database.url(), "username", System.getProperty("mysql.user"),
                    "password", System.getProperty("mysql.password", ""))),
                    "qwen", Map.of("managed-agent", Map.of(
                            "harness", Map.of("enabled", true, "workspace-files-enabled", true),
                            "session-store", Map.of("enabled", true),
                            "runtime-broker", Map.ofEntries(Map.entry("enabled", true),
                                    Map.entry("provisioner", "kubernetes-workspace"), Map.entry("isolation-class", "workspace"),
                                    Map.entry("trusted-local-reboot-recovery", false),
                                    Map.entry("resident-kubernetes-api-url", "https://cluster.example"),
                                    Map.entry("resident-kubernetes-token-file", "/unused-token"),
                                    Map.entry("resident-kubernetes-ca-file", "/unused-ca"),
                                    Map.entry("credential-key-id", "test"),
                                    Map.entry("credential-key", Base64.getEncoder().encodeToString(new byte[32])),
                                    Map.entry("resident-workspaces", List.of(fixture.mapping)))))));
            assertThat(json.readTree(run("inspect", request, config)).path("state").asText()).isEqualTo("NOT_STARTED");
            assertThat(fixture.jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation", Integer.class)).isZero();
            String admitted = run("begin", request, config);
            assertThat(json.readTree(admitted).path("state").asText()).isEqualTo("DRAINING");
            assertThat(json.readTree(run("inspect", request, config))).isEqualTo(json.readTree(admitted));
            assertThat(json.readTree(run("begin", request, config))).isEqualTo(json.readTree(admitted));
            assertThat(fixture.jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE operation_kind = 'WORKSPACE_RETIREMENT'",
                    Integer.class)).isEqualTo(1);
            assertThat(fixture.attempts()).isEmpty();
            assertThat(fixture.storage.inspect(fixture.mapping.registration())).isEqualTo(reservation);
            assertThat(admitted).doesNotContain(fixture.original.getProvisionSeed().getToken(), "credential-key", "password");
        }
    }

    private String run(String action, Path request, String config) throws Exception {
        var command = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java").toString(), "-cp",
                System.getProperty("surefire.test.class.path", System.getProperty("java.class.path")),
                ResidentWorkspaceRetirementMain.class.getName(), action, request.toString(),
                "--spring.config.location=optional:classpath:/resident-retirement-test.properties");
        command.environment().put("SPRING_APPLICATION_JSON", config);
        Path output = directory.resolve(action + "-" + java.util.UUID.randomUUID() + ".log");
        Path errors = directory.resolve(action + "-" + java.util.UUID.randomUUID() + ".err");
        var process = command.redirectError(errors.toFile()).redirectOutput(output.toFile()).start();
        try {
            assertThat(process.waitFor(30, TimeUnit.SECONDS)).isTrue();
            assertThat(process.exitValue()).as("Private maintenance process must succeed; stderr: %s", errors).isZero();
            // spring-jcl can report classpath discovery before Boot configures logging.
            String value = Files.readString(output, StandardCharsets.UTF_8).lines()
                    .filter(line -> !line.startsWith("Standard Commons Logging discovery in action with spring-jcl:"))
                    .collect(java.util.stream.Collectors.joining("\n")).strip();
            assertThat(value).startsWith("{").endsWith("}");
            return value;
        } finally {
            if (process.isAlive()) {
                process.destroyForcibly();
            }
        }
    }
}
