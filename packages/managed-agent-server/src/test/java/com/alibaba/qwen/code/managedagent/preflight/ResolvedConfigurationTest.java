package com.alibaba.qwen.code.managedagent.preflight;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.ApplicationContextFactory;
import org.springframework.boot.WebApplicationType;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.MapPropertySource;
import org.springframework.core.env.MutablePropertySources;
import org.springframework.core.env.StandardEnvironment;
import org.springframework.core.env.SystemEnvironmentPropertySource;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ResolvedConfigurationTest {
    private static final String STATE = "runtimeStateDirectory";

    @TempDir
    Path directory;

    /** Resolves with these process variables and no system properties. */
    private static Map<String, String> resolve(Map<String, Object> variables,
            String... args) {
        ConfigurableEnvironment environment = ApplicationContextFactory.DEFAULT
                .createEnvironment(WebApplicationType.SERVLET);
        MutablePropertySources sources = environment.getPropertySources();
        sources.replace(
                StandardEnvironment.SYSTEM_ENVIRONMENT_PROPERTY_SOURCE_NAME,
                new SystemEnvironmentPropertySource(
                        StandardEnvironment.SYSTEM_ENVIRONMENT_PROPERTY_SOURCE_NAME,
                        variables));
        sources.replace(
                StandardEnvironment.SYSTEM_PROPERTIES_PROPERTY_SOURCE_NAME,
                new MapPropertySource(
                        StandardEnvironment.SYSTEM_PROPERTIES_PROPERTY_SOURCE_NAME,
                        Map.of()));
        return ResolvedConfiguration.resolve(args, environment);
    }

    private Path write(String name, String text) throws IOException {
        Path file = directory.resolve(name);
        Files.createDirectories(file.getParent());
        Files.writeString(file, text);
        return file;
    }

    /** The launcher's way of naming config/application.yml. */
    private static Map<String, Object> additional(Path location) {
        Map<String, Object> variables = new HashMap<>();
        variables.put("SPRING_CONFIG_ADDITIONAL_LOCATION", "file:" + location
                + (Files.isDirectory(location) ? "/" : ""));
        return variables;
    }

    @Test
    void readsTheVariableTheShippedDefaultsMap() {
        Map<String, String> resolved = resolve(Map.of(
                "QWEN_MANAGED_AGENT_RUNTIME_STATE_DIRECTORY", "/var/lib/state"));
        assertEquals("/var/lib/state", resolved.get(STATE));
        assertEquals("QWEN_MANAGED_AGENT_RUNTIME_STATE_DIRECTORY",
                resolved.get("runtimeStateOrigin"));
        assertEquals("", resolve(Map.of()).get(STATE));
    }

    @Test
    void followsAnImportInTheLaunchersFile() throws IOException {
        Path imported = write("etc/runtime.yml", """
                qwen:
                  managed-agent:
                    runtime-broker:
                      state-directory: /srv/imported
                """);
        Path config = write("config/application.yml",
                "spring.config.import: file:" + imported + "\n");
        Map<String, String> resolved = resolve(additional(config));
        assertEquals("/srv/imported", resolved.get(STATE));
        assertTrue(resolved.get("runtimeStateOrigin").contains("runtime.yml"),
                resolved.get("runtimeStateOrigin"));
    }

    // The reviewer's case: a flow mapping whose sibling keys a line reader
    // took for one path.
    @Test
    void readsAFlowMappingWithSiblingKeys() throws IOException {
        Path imported = write("etc/runtime.yml",
                "qwen.managed-agent.runtime-broker.state-directory: /srv/flow\n");
        Path config = write("config/application.yml",
                "spring: {application: {name: managed-agent}, config: {import: \"file:"
                        + imported + "\"}}\n");
        assertEquals("/srv/flow", resolve(additional(config)).get(STATE));
    }

    @Test
    void readsAMergeKey() throws IOException {
        Path config = write("config/application.yml", """
                defaults: &defaults
                  state-directory: /srv/merged
                qwen:
                  managed-agent:
                    runtime-broker:
                      <<: *defaults
                """);
        assertEquals("/srv/merged", resolve(additional(config)).get(STATE));
    }

    @Test
    void addsTheAdditionalLocationToTheDefaults() throws IOException {
        Path config = write("config/application.yml", """
                spring.profiles.active: edge
                """);
        write("config/application-edge.properties",
                "qwen.managed-agent.runtime-broker.state-directory=/srv/edge\n");
        // A directory location reads the profile's file beside it, and the
        // packaged application.yml still supplies everything else.
        Map<String, String> resolved =
                resolve(additional(config.getParent()));
        assertEquals("/srv/edge", resolved.get(STATE));
        assertEquals("open", resolved.get("authMode"));
    }

    @Test
    void readsTheConfigurationNameAndPropertiesFiles() throws IOException {
        write("config/server.properties",
                "qwen.managed-agent.runtime-broker.state-directory=/srv/named\n");
        Map<String, Object> variables = additional(directory.resolve("config"));
        variables.put("SPRING_CONFIG_NAME", "application,server");
        assertEquals("/srv/named", resolve(variables).get(STATE));
    }

    @Test
    void bindsEveryEnvironmentSpelling() {
        for (String name : new String[] {
                "QWEN_MANAGED_AGENT_RUNTIME_BROKER_STATE_DIRECTORY",
                "QWEN_MANAGEDAGENT_RUNTIMEBROKER_STATEDIRECTORY"}) {
            Map<String, String> resolved = resolve(Map.of(
                    "QWEN_MANAGED_AGENT_RUNTIME_STATE_DIRECTORY", "/srv/documented",
                    name, "/srv/relaxed"));
            assertEquals("/srv/relaxed", resolved.get(STATE), name);
        }
        assertEquals("/srv/json", resolve(Map.of("SPRING_APPLICATION_JSON",
                "{\"qwen\":{\"managed-agent\":{\"runtime-broker\":"
                        + "{\"state-directory\":\"/srv/json\"}}}}")).get(STATE));
    }

    @Test
    void resolvesARelativeDirectoryInTheWorkingDirectory() {
        Map<String, String> resolved = resolve(Map.of(),
                "--qwen.managed-agent.runtime-broker.state-directory=state/../runtime");
        assertEquals(Path.of("runtime").toAbsolutePath().toString(),
                resolved.get(STATE));
        assertTrue(resolved.get("runtimeStateOrigin").contains("commandLineArgs"),
                resolved.get("runtimeStateOrigin"));
    }

    @Test
    void readsTheAuthModeAndActorHeaderAsStartupDoes() {
        assertEquals("signed", resolve(Map.of(
                "QWEN_MANAGED_AGENT_AUTH_MODE", " SIGNED ")).get("authMode"));
        assertEquals("open", resolve(Map.of(
                "QWEN_MANAGED_AGENT_AUTH_MODE", "open")).get("authMode"));
        Map<String, String> resolved = resolve(Map.of(
                "QWEN_MANAGED_AGENT_TRUSTED_ACTOR_HEADER", " X-Actor "));
        assertEquals("X-Actor", resolved.get("trustedActorHeader"));
        assertEquals("", resolve(Map.of()).get("trustedActorHeader"));
    }

    @Test
    void refusesAConfigurationTheServerWouldRefuse() throws IOException {
        Path config = write("config/application.yml",
                "spring.config.import: file:" + directory.resolve("missing.yml") + "\n");
        assertThrows(RuntimeException.class,
                () -> resolve(additional(config)));
    }

    @Test
    void printsOneMarkedLine() throws IOException {
        PrintStream out = System.out;
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        int status;
        try {
            System.setOut(new PrintStream(buffer, true, StandardCharsets.UTF_8));
            status = ResolvedConfiguration.run(new String[] {
                    "--qwen.managed-agent.runtime-broker.state-directory=/srv/run"});
        } finally {
            System.setOut(out);
        }
        assertEquals(0, status);
        String line = buffer.toString(StandardCharsets.UTF_8).strip();
        assertTrue(line.startsWith(ResolvedConfiguration.PREFIX), line);
        Map<?, ?> printed = new ObjectMapper().readValue(
                line.substring(ResolvedConfiguration.PREFIX.length()), Map.class);
        assertEquals("/srv/run", printed.get(STATE));

        PrintStream err = System.err;
        try {
            System.setErr(new PrintStream(new ByteArrayOutputStream(), true,
                    StandardCharsets.UTF_8));
            assertEquals(1, ResolvedConfiguration.run(new String[] {
                    "--spring.config.import=file:" + directory.resolve("none.yml")}));
        } finally {
            System.setErr(err);
        }
    }
}
