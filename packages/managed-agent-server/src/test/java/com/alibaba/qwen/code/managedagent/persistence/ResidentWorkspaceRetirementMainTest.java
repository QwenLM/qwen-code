package com.alibaba.qwen.code.managedagent.persistence;

import com.fasterxml.jackson.core.StreamReadFeature;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.MapperFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ResidentWorkspaceRetirementMainTest {
    private final ObjectMapper json = JsonMapper.builder().enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .disable(DeserializationFeature.ACCEPT_FLOAT_AS_INT)
            .disable(MapperFeature.ALLOW_COERCION_OF_SCALARS)
            .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();
    @TempDir
    private Path directory;

    @Test
    void readsOnlyTheBoundedScopeRequest() throws Exception {
        Path file = directory.resolve("request.json");
        Files.writeString(file, "{\"tenantId\":\"tenant\",\"workspaceId\":\"workspace\",\"workspaceGeneration\":1,"
                + "\"actorId\":\"owner\",\"retirementId\":\"retire\"}");
        assertThat(ResidentWorkspaceRetirementMain.readRequest(file, json))
                .isEqualTo(new ResidentWorkspaceRetirementStore.Request("tenant", "workspace", 1, "owner", "retire"));
        for (String invalid : new String[] {"null", "{}", "{\"tenantId\":\"a\",\"tenantId\":\"b\"}",
                Files.readString(file).replace("\"workspaceGeneration\":1", "\"workspaceGeneration\":0"),
                Files.readString(file).replace("\"workspaceGeneration\":1", "\"workspaceGeneration\":1.5"),
                Files.readString(file).replace("\"workspaceGeneration\":1", "\"workspaceGeneration\":\"1\""),
                Files.readString(file).replace("}", ",\"podName\":\"replacement\"}"),
                Files.readString(file) + "{}", Files.readString(file) + " ".repeat(16 * 1024)}) {
            Files.writeString(file, invalid);
            assertThatThrownBy(() -> ResidentWorkspaceRetirementMain.readRequest(file, json)).isInstanceOf(Exception.class);
        }
    }

    @Test
    void nonIntegerGenerationsRefuseInTheRealEntryBeforeDeploymentBootstrap() throws Exception {
        Path file = directory.resolve("generation.json");
        for (String generation : new String[] {"1.5", "\"1\""}) {
            Files.writeString(file, "{\"tenantId\":\"tenant\",\"workspaceId\":\"workspace\",\"workspaceGeneration\":"
                    + generation + ",\"actorId\":\"owner\",\"retirementId\":\"retire\"}");
            assertThatThrownBy(() -> ResidentWorkspaceRetirementMain.run(new String[] {"inspect", file.toString(),
                    "--spring.autoconfigure.exclude=org.springframework.boot.autoconfigure.jdbc.DataSourceAutoConfiguration"}))
                    .isInstanceOf(com.fasterxml.jackson.databind.JsonMappingException.class);
        }
    }

    @Test
    void invalidActionsRefuseBeforeBootstrappingOrReadingDeploymentConfiguration() {
        for (String[] args : new String[][] {{}, {"begin"}, {"release", "request"},
                {"delete-pod", "request"}, {"inspect", "request", "extra"}}) {
            assertThatThrownBy(() -> ResidentWorkspaceRetirementMain.run(args)).isInstanceOf(IllegalArgumentException.class);
        }
    }

    @Test
    void privateMainRedactsInputAndExceptionDetailsInASeparateJvm() throws Exception {
        String sentinel = "private-credential-must-not-appear";
        var process = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java").toString(),
                "-cp", System.getProperty("surefire.test.class.path", System.getProperty("java.class.path")),
                ResidentWorkspaceRetirementMain.class.getName(), "inspect", directory.resolve(sentinel).toString())
                .redirectErrorStream(true).start();
        try {
            assertThat(process.waitFor(20, TimeUnit.SECONDS)).isTrue();
            assertThat(process.exitValue()).isEqualTo(1);
            assertThat(new String(process.getInputStream().readAllBytes(), java.nio.charset.StandardCharsets.UTF_8))
                    .contains("Resident Workspace retirement could not be completed")
                    .doesNotContain(sentinel, "Exception", "at com.alibaba");
        } finally {
            if (process.isAlive()) {
                process.destroyForcibly();
            }
        }
    }
}
