package com.alibaba.qwen.code.managedagent;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.zip.ZipFile;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

class ManagedAgentPackagingIT {
    @TempDir
    Path directory;
    @Test
    void standaloneArtifactsIncludeConfigurationWhileLibraryDoesNot() throws Exception {
        String prefix = System.getProperty("managed.artifact.directory") + "/qwen-managed-agent-server-" + System.getProperty("managed.artifact.version");
        try (var library = new ZipFile(Path.of(prefix + ".jar").toFile())) {
            assertThat(library.getEntry("application.yml")).isNull();
            assertThat(library.getEntry("application-managed-local.yml")).isNull();
        }
        var classifiers = Boolean.getBoolean("managed.operator.tools.enabled")
                ? List.of("exec", "workspace-bundle", "workspace-migration", "workspace-maintenance-recovery",
                        "csi-session", "csi-runtime", "operator-recovery") : List.of("exec");
        for (String classifier : classifiers) {
            try (var executable = new ZipFile(Path.of(prefix + "-" + classifier + ".jar").toFile())) {
                assertThat(executable.getEntry("BOOT-INF/classes/application.yml")).as(classifier).isNotNull();
                assertThat(executable.getEntry("BOOT-INF/classes/application-managed-local.yml")).as(classifier).isNotNull();
            }
        }
    }

    @Test
    void retirementLauncherLoadsFromExecutableJar() throws Exception {
        Path jar = Path.of(System.getProperty("managed.artifact.directory") + "/qwen-managed-agent-server-" + System.getProperty("managed.artifact.version")
                + "-exec.jar").toAbsolutePath();
        Path log = directory.resolve("retirement.log");
        Process process = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java").toString(),
                "-Dloader.main=com.alibaba.qwen.code.managedagent.maintenance.ResidentWorkspaceRetirementMain",
                "-cp", jar.toString(), "org.springframework.boot.loader.launch.PropertiesLauncher")
                .redirectErrorStream(true).redirectOutput(log.toFile()).start();
        try {
            assertThat(process.waitFor(30, TimeUnit.SECONDS)).isTrue();
            assertThat(process.exitValue()).isNotZero();
            assertThat(Files.readString(log)).contains("Resident Workspace retirement could not be completed");
        } finally {
            if (process.isAlive()) {
                process.destroyForcibly();
            }
        }
    }

    @Test
    void operatorRecoveryReadsDocumentedEnvironment() throws Exception {
        assumeTrue(Boolean.getBoolean("managed.operator.tools.enabled"));
        Path jar = Path.of(System.getProperty("managed.artifact.directory") + "/qwen-managed-agent-server-" + System.getProperty("managed.artifact.version")
                + "-operator-recovery.jar").toAbsolutePath();
        Path log = directory.resolve("operator.log");
        var builder = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java").toString(),
                "-jar", jar.toString(), "inspect", "unused", "1")
                .redirectErrorStream(true).redirectOutput(log.toFile());
        builder.environment().put("SPRING_DATASOURCE_URL", "jdbc:h2:mem:packaging");
        builder.environment().put("SPRING_DATASOURCE_USERNAME", "sa");
        builder.environment().put("QWEN_MANAGED_AGENT_RUNTIME_OPERATOR_RECOVERY_ENABLED", "true");
        builder.environment().put("QWEN_MANAGED_AGENT_RUNTIME_DURABLE_LOCAL_PROCESS", "true");
        builder.environment().put("QWEN_MANAGED_AGENT_RUNTIME_PROVISIONER", "local-process");
        builder.environment().put("QWEN_MANAGED_AGENT_RUNTIME_STATE_DIRECTORY", directory.resolve("missing").toString());
        builder.environment().put("QWEN_MANAGED_AGENT_RUNTIME_CREDENTIAL_KEY_ID", "test");
        builder.environment().put("QWEN_MANAGED_AGENT_RUNTIME_CREDENTIAL_KEY", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
        Process process = builder.start();
        try {
            assertThat(process.waitFor(30, TimeUnit.SECONDS)).isTrue();
            assertThat(process.exitValue()).isNotZero();
            assertThat(Files.readString(log)).contains("Original Runtime state directory is unavailable");
        } finally {
            if (process.isAlive()) {
                process.destroyForcibly();
            }
        }
    }
}
