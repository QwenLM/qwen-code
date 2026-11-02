package com.alibaba.qwen.code.managedagent;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.jar.JarFile;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

class ManagedAgentPackagingIT {
    private static final List<String> BACKENDS = List.of("external", "kubernetes", "local", "ssh", "static");

    @TempDir
    Path directory;
    @Test
    void standaloneArtifactsIncludeConfigurationWhileLibraryDoesNot() throws Exception {
        String prefix = System.getProperty("managed.artifact.directory") + "/qwen-managed-agent-server-" + System.getProperty("managed.artifact.version");
        try (var library = new JarFile(Path.of(prefix + ".jar").toFile())) {
            assertThat(library.getEntry("application.yml")).isNull();
            assertThat(library.getEntry("application-managed-local.yml")).isNull();
            assertThat(library.getManifest().getMainAttributes().getValue("Qwen-Runtime-Variant")).isNull();
        }
        var classifiers = new ArrayList<>(List.of(classifier()));
        if (Boolean.getBoolean("managed.operator.tools.enabled")) {
            classifiers.addAll(List.of("workspace-bundle", "workspace-migration", "workspace-maintenance-recovery",
                    "csi-session", "csi-runtime", "operator-recovery"));
        }
        for (String classifier : classifiers) {
            try (var executable = new JarFile(Path.of(prefix + "-" + classifier + ".jar").toFile())) {
                assertThat(executable.getEntry("BOOT-INF/classes/application.yml")).as(classifier).isNotNull();
                assertThat(executable.getEntry("BOOT-INF/classes/application-managed-local.yml")).as(classifier).isNotNull();
                assertThat(executable.getEntry("BOOT-INF/classes/META-INF/spring-configuration-metadata.json")).isNotNull();
                if (classifier.equals(classifier())) {
                    assertThat(executable.getManifest().getMainAttributes().getValue("Qwen-Runtime-Backends"))
                            .isEqualTo(String.join(",", selected()));
                    assertThat(executable.getManifest().getMainAttributes().getValue("Qwen-Runtime-Variant"))
                            .isEqualTo(System.getProperty("managed.runtime.variant"));
                }
                for (String backend : BACKENDS) {
                    String module = "runtime-" + backend;
                    var entry = executable.getEntry("BOOT-INF/lib/qwen-managed-agent-" + module + "-"
                            + System.getProperty("managed.artifact.version") + ".jar");
                    if (!selected().contains(backend)) {
                        assertThat(entry).as(classifier + " excluded " + module).isNull();
                        continue;
                    }
                    assertThat(entry).as(classifier + " " + module).isNotNull();
                    boolean registered = false;
                    try (var nested = new java.util.jar.JarInputStream(executable.getInputStream(entry))) {
                        java.util.jar.JarEntry resource;
                        while ((resource = nested.getNextJarEntry()) != null) {
                            if (resource.getName().equals("META-INF/services/com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderFactory")) {
                                assertThat(new String(nested.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8))
                                        .contains("RuntimeProviderFactory");
                                registered = true;
                            }
                        }
                    }
                    assertThat(registered).as("provider registration in " + module).isTrue();
                }
                assertThat(executable.stream().map(entry -> entry.getName()))
                        .as(classifier + " runtime libraries")
                        .noneMatch(name -> name.startsWith("BOOT-INF/lib/lombok-"));
            }
        }
    }

    @Test
    void executableDiscoversOnlyItsPackagedProvidersAndBootsWithoutTheBroker() throws Exception {
        Path probe = directory.resolve("probe");
        Path target = probe.resolve("com/alibaba/qwen/code/managedagent/RuntimeArtifactProbe.class");
        Files.createDirectories(target.getParent());
        try (var source = RuntimeArtifactProbe.class.getResourceAsStream("RuntimeArtifactProbe.class")) {
            Files.copy(source, target);
        }
        Path log = directory.resolve("providers.log");
        var command = new ArrayList<>(List.of(Path.of(System.getProperty("java.home"), "bin", "java").toString(),
                "-Dloader.main=" + RuntimeArtifactProbe.class.getName(), "-Dloader.path=" + probe.toUri(),
                "-cp", executable().toString(), "org.springframework.boot.loader.launch.PropertiesLauncher",
                String.join(",", selected())));
        for (String backend : BACKENDS) {
            if (!selected().contains(backend)) {
                Path classes = Path.of("..", "runtime-" + backend, "target", "classes");
                try (var files = Files.walk(classes)) {
                    files.filter(file -> file.toString().endsWith(".class"))
                            .map(file -> classes.relativize(file).toString().replace(java.io.File.separatorChar, '.'))
                            .map(name -> name.substring(0, name.length() - ".class".length())).forEach(command::add);
                }
            }
        }
        var process = new ProcessBuilder(command).redirectErrorStream(true).redirectOutput(log.toFile()).start();
        try {
            assertThat(process.waitFor(60, TimeUnit.SECONDS)).isTrue();
            assertThat(process.exitValue()).as(Files.readString(log)).isZero();
            assertThat(Files.readString(log)).contains("Runtime providers: " + String.join(",", selected()),
                    "Disabled Runtime application started");
        } finally {
            if (process.isAlive()) {
                process.destroyForcibly();
            }
        }
    }

    @Test
    void retirementLauncherLoadsFromExecutableJar() throws Exception {
        Path jar = executable();
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
        assumeTrue(selected().contains("local"));
        Path jar = executable();
        Path log = directory.resolve("operator.log");
        var command = new ArrayList<>(List.of(Path.of(System.getProperty("java.home"), "bin", "java").toString()));
        if (Boolean.getBoolean("managed.operator.tools.enabled")) {
            Path operator = jar.resolveSibling("qwen-managed-agent-server-" + System.getProperty("managed.artifact.version")
                    + "-operator-recovery.jar");
            command.addAll(List.of("-jar", operator.toString()));
        } else {
            command.addAll(List.of("-Dloader.main=com.alibaba.qwen.code.managedagent.maintenance.WorkspaceRecoveryCommand",
                    "-cp", jar.toString(), "org.springframework.boot.loader.launch.PropertiesLauncher"));
        }
        command.addAll(List.of("inspect", "unused", "1"));
        var builder = new ProcessBuilder(command)
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

    private static List<String> selected() {
        return Arrays.asList(System.getProperty("managed.runtime.backends").split(","));
    }

    private static String classifier() {
        return System.getProperty("managed.exec.classifier");
    }

    private static Path executable() {
        return Path.of(System.getProperty("managed.artifact.directory"), "qwen-managed-agent-server-"
                + System.getProperty("managed.artifact.version") + "-" + classifier() + ".jar").toAbsolutePath();
    }
}
