package com.alibaba.qwen.code.managedagent;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.jar.JarInputStream;
import java.util.zip.ZipFile;

import static org.assertj.core.api.Assertions.assertThat;

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
        for (String classifier : List.of("exec")) {
            try (var executable = new ZipFile(Path.of(prefix + "-" + classifier + ".jar").toFile())) {
                assertThat(executable.getEntry("BOOT-INF/classes/application.yml")).as(classifier).isNotNull();
                assertThat(executable.getEntry("BOOT-INF/classes/application-managed-local.yml")).as(classifier).isNotNull();
                assertThat(executable.getEntry("META-INF/spring-configuration-metadata.json")).as(classifier).isNotNull();
                assertThat(executable.stream().map(entry -> entry.getName()))
                        .as(classifier + " runtime libraries")
                        .noneMatch(name -> name.startsWith("BOOT-INF/lib/lombok-"));
            }
        }
    }

    @Test
    void defaultExecutableIncludesAllBackendRegistrations() throws Exception {
        Path jar = Path.of(System.getProperty("managed.artifact.directory"), "qwen-managed-agent-server-"
                + System.getProperty("managed.artifact.version") + "-exec.jar");
        try (var executable = new ZipFile(jar.toFile())) {
            for (var backend : Map.of("external", "external.ExternalRuntimeProviderFactory",
                    "kubernetes", "kubernetes.KubernetesRuntimeProviderFactory", "local", "local.LocalRuntimeProviderFactory",
                    "ssh", "ssh.SshRuntimeProviderFactory", "static", "staticruntime.StaticRuntimeProviderFactory").entrySet()) {
                var entry = executable.getEntry("BOOT-INF/lib/qwen-managed-agent-runtime-" + backend.getKey() + "-"
                        + System.getProperty("managed.artifact.version") + ".jar");
                assertThat(entry).as(backend.getKey()).isNotNull();
                String registration = null;
                try (var nested = new JarInputStream(executable.getInputStream(entry))) {
                    java.util.jar.JarEntry resource;
                    while ((resource = nested.getNextJarEntry()) != null) {
                        if (resource.getName().equals("META-INF/services/com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderFactory")) {
                            registration = new String(nested.readAllBytes(), StandardCharsets.UTF_8).trim();
                        }
                    }
                }
                assertThat(registration).as(backend.getKey()).isEqualTo("com.alibaba.qwen.code.runtimebroker.provisioning." + backend.getValue());
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
            assertThat(Files.readString(log)).doesNotContain("NoClassDefFoundError", "ClassNotFoundException");
        } finally {
            if (process.isAlive()) {
                process.destroyForcibly();
            }
        }
    }

    @Test
    void operatorRecoveryReadsDocumentedEnvironment() throws Exception {
        Path jar = Path.of(System.getProperty("managed.artifact.directory") + "/qwen-managed-agent-server-" + System.getProperty("managed.artifact.version")
                + "-exec.jar").toAbsolutePath();
        Path log = directory.resolve("operator.log");
        var builder = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "java").toString(),
                "-Dloader.main=com.alibaba.qwen.code.managedagent.maintenance.WorkspaceRecoveryCommand",
                "-cp", jar.toString(), "org.springframework.boot.loader.launch.PropertiesLauncher", "inspect", "unused", "1")
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
