package com.alibaba.qwen.code.managedagent;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

class ContainerArtifactSelectionTest {
    @TempDir
    Path directory;

    @Test
    void shippedContainerSelectsOnlyTheExecutableClassifier() throws Exception {
        Files.writeString(directory.resolve("qwen-managed-agent-server-0.1.0-alpha.jar"), "plain");
        Files.writeString(directory.resolve("qwen-managed-agent-server-0.1.0-alpha-exec.jar"), "executable");
        Files.writeString(directory.resolve("qwen-managed-agent-server-0.1.0-alpha-workspace-bundle.jar"), "operator");
        assertThat(select()).isZero();
        assertThat(Files.readString(directory.resolve("selected.jar"))).isEqualTo("executable");
    }

    @Test
    void shippedContainerRejectsMissingOrAmbiguousExecutable() throws Exception {
        Files.writeString(directory.resolve("qwen-managed-agent-server-0.1.0-alpha.jar"), "plain");
        assertThat(select()).isNotZero();
        Files.writeString(directory.resolve("qwen-managed-agent-server-0.1.0-alpha-exec.jar"), "first");
        Files.writeString(directory.resolve("qwen-managed-agent-server-0.2.0-alpha-exec.jar"), "second");
        assertThat(select()).isNotZero();
        assertThat(directory.resolve("selected.jar")).doesNotExist();
    }

    private int select() throws Exception {
        String dockerfile = Files.readString(Path.of("Dockerfile"));
        String start = "main=\"\" && count=0";
        String end = "&& cp \"$main\" /tmp/qwen-managed-agent-server.jar";
        int from = dockerfile.indexOf(start);
        int to = dockerfile.indexOf(end, from);
        assertThat(from).isGreaterThanOrEqualTo(0);
        assertThat(to).isGreaterThan(from);
        String script = dockerfile.substring(from, to + end.length())
                .replace("\\\n", " ").replace("/tmp/qwen-managed-agent-server.jar", "selected.jar");
        Process process = new ProcessBuilder("sh", "-c", script).directory(directory.toFile())
                .redirectErrorStream(true).redirectOutput(directory.resolve("selector.log").toFile()).start();
        try {
            assertThat(process.waitFor(5, TimeUnit.SECONDS)).isTrue();
            return process.exitValue();
        } finally {
            if (process.isAlive()) {
                process.destroyForcibly();
            }
        }
    }
}
