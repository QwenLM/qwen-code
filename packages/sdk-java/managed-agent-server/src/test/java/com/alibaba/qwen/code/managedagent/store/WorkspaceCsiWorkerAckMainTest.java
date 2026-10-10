package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class WorkspaceCsiWorkerAckMainTest {
    @TempDir
    Path temporary;

    @Test
    void nativeCommandReadsHistoricalDocumentFromIndependentJdbcConnectionWithoutOssConfiguration() throws Exception {
        String url = url();
        var fixture = WorkspaceCsiWorkerAckStoreTest.fixture(url);
        var settings = settings(url);
        settings.put("QWEN_MANAGED_AGENT_TOOL_PUBLICATION_OSS_ENDPOINT", "invalid://must-not-be-used-for-inspect");
        var result = run(settings, arguments("inspect", fixture.selector()));
        assertThat(result.exit()).isZero();
        JsonNode printed = WorkspaceCsiWorkerAckStoreTest.JSON.readTree(result.output().lines()
                .filter(line -> line.startsWith("{\"document\":")).findFirst().orElseThrow());
        assertThat(printed.path("document")).isEqualTo(fixture.document());
        assertThat(printed.path("recordedAtEpochMicros").longValue()).isEqualTo(WorkspaceCsiWorkerAckStoreTest.OBSERVED);
        assertThat(fixture.rows()).isEqualTo(1);
        assertThat(result.output()).doesNotContain("fixture-password", "invalid://must-not-be-used-for-inspect");
    }

    @Test
    void historicalFixtureCannotAuthorizeAcknowledgeOrInsertAnotherRow() throws Exception {
        String url = url();
        var fixture = WorkspaceCsiWorkerAckStoreTest.fixture(url);
        var result = run(settings(url), arguments("acknowledge", fixture.selector()));
        assertFailure(result);
        assertThat(fixture.rows()).isEqualTo(1);
        assertThat(fixture.jdbc().queryForObject("SELECT COUNT(*) FROM qwen_tool_execution", Long.class)).isZero();
        assertThat(fixture.jdbc().queryForObject("SELECT COUNT(*) FROM qwen_runtime_binding", Long.class)).isZero();
    }

    @Test
    void invalidSelectorsAndMissingSettingsFailWithRedactedOutput() throws Exception {
        assertFailure(run(Map.of(), List.of()));
        assertFailure(run(Map.of(), List.of("inspect", "invalid-retirement", "tenant", "workspace", "session", "publication")));
        assertFailure(run(Map.of(), List.of("inspect", UUID.randomUUID().toString(), "tenant", "workspace", "session", "publication")));
    }

    @Test
    void invalidCredentialConfigurationCannotReadOrLeakHistoricalEvidence() throws Exception {
        String url = url();
        var fixture = WorkspaceCsiWorkerAckStoreTest.fixture(url);
        var settings = settings(url);
        settings.put("QWEN_MANAGED_AGENT_RUNTIME_CREDENTIAL_KEY", "invalid-secret-do-not-print");
        var result = run(settings, arguments("inspect", fixture.selector()));
        assertFailure(result);
        assertThat(result.output()).doesNotContain("invalid-secret-do-not-print", fixture.document().toString());
        assertThat(fixture.rows()).isEqualTo(1);
    }

    private Result run(Map<String, String> settings, List<String> args) throws Exception {
        var command = new ArrayList<>(List.of(Path.of(System.getProperty("java.home"), "bin", "java").toString(), "-cp",
                System.getProperty("surefire.test.class.path", System.getProperty("java.class.path")), WorkspaceCsiWorkerAckMain.class.getName()));
        command.addAll(args);
        Path output = temporary.resolve("main-" + UUID.randomUUID() + ".log");
        var builder = new ProcessBuilder(command).redirectErrorStream(true).redirectOutput(output.toFile());
        builder.environment().keySet().removeIf(key -> key.startsWith("K2_JDBC_")
                || key.startsWith("QWEN_MANAGED_AGENT_RUNTIME_CREDENTIAL_") || key.startsWith("QWEN_MANAGED_AGENT_TOOL_PUBLICATION_OSS_")
                || key.startsWith("ALIBABA_CLOUD_"));
        builder.environment().putAll(settings);
        Process process = builder.start();
        try {
            assertThat(process.waitFor(20, TimeUnit.SECONDS)).as("private ACK command deadline").isTrue();
            return new Result(process.exitValue(), Files.readString(output, StandardCharsets.UTF_8));
        } finally {
            if (process.isAlive()) {
                process.destroyForcibly();
                assertThat(process.waitFor(5, TimeUnit.SECONDS)).isTrue();
            }
        }
    }

    private String url() {
        return "jdbc:h2:file:" + temporary.resolve("historical-ack").toAbsolutePath() + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE";
    }

    private static Map<String, String> settings(String url) {
        var settings = new java.util.HashMap<String, String>();
        settings.put("K2_JDBC_URL", url);
        settings.put("K2_JDBC_USER", "sa");
        settings.put("K2_JDBC_PASSWORD", "fixture-password");
        settings.put("QWEN_MANAGED_AGENT_RUNTIME_CREDENTIAL_KEY_ID", "fixture");
        settings.put("QWEN_MANAGED_AGENT_RUNTIME_CREDENTIAL_KEY", Base64.getEncoder().encodeToString(new byte[32]));
        return settings;
    }

    private static List<String> arguments(String operation, WorkspaceCsiWorkerAckStore.Selector selector) {
        return List.of(operation, selector.retirementId(), selector.tenantId(), selector.workspaceId(), selector.sessionId(), selector.publicationId());
    }

    private static void assertFailure(Result result) {
        assertThat(result.exit()).isEqualTo(1);
        assertThat(result.output()).contains("Original CSI worker acknowledgement could not be completed.")
                .doesNotContain("fixture-password", "Exception", "{\"document\":");
    }

    private record Result(int exit, String output) {
    }
}
