package com.alibaba.qwen.code.managedagent.preflight;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore;
import com.alibaba.qwen.code.managedagent.harness.QwenHostedHarnessConnector;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceExecutionStore;
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
import java.util.LinkedHashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;

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
    void reachesTheServerWhereItsConfigurationBindsIt() throws IOException {
        Map<String, String> defaults = resolve(Map.of());
        assertEquals("http://127.0.0.1:8080", defaults.get("serverUrl"));
        assertEquals("http://127.0.0.1:8080/actuator/health",
                defaults.get("healthUrl"));
        assertEquals("http://127.0.0.1:4170", defaults.get("harnessBaseUrl"));
        // The Harness is disabled by default, so the server never reads it.
        assertEquals("skip", defaults.get("harnessOrigin"));
        assertEquals("true", resolve(Map.of(
                "QWEN_MANAGED_AGENT_HARNESS_ENABLED", "true"))
                .get("harnessOrigin"));

        // The port in the launcher's file, where server.env cannot see it.
        Path config = write("config/application.yml", """
                server:
                  port: 9090
                qwen.managed-agent.harness.enabled: true
                qwen.managed-agent.harness.base-url: ' http://127.0.0.1:4171 '
                """);
        Map<String, String> file = resolve(additional(config));
        assertEquals("http://127.0.0.1:9090", file.get("serverUrl"));
        // As the server parses it, untrimmed, which the preflight fails.
        assertEquals(" http://127.0.0.1:4171 ", file.get("harnessBaseUrl"));
        assertEquals("false", file.get("harnessOrigin"));
        assertEquals("http://127.0.0.1:9091",
                resolve(Map.of("SERVER_PORT", "9091")).get("serverUrl"));
        assertEquals("http://127.0.0.1:9092",
                resolve(Map.of(), "--server.port=9092").get("serverUrl"));

        // A wildcard serves the loopback interface of its family, and the
        // relaxed SERVER_ADDRESS outranks the packaged default too. A
        // link-local address keeps its zone, which the upgrade command
        // refuses, since no URL carries one.
        Map<String, String> addresses = Map.of(
                "0.0.0.0", "http://127.0.0.1:8080",
                "::", "http://[::1]:8080",
                "0:0:0:0:0:0:0:1", "http://[::1]:8080",
                "10.1.2.3", "http://10.1.2.3:8080",
                "fe80::1%1", "http://[fe80:0:0:0:0:0:0:1%1]:8080",
                "", "http://127.0.0.1:8080");
        addresses.forEach((address, url) -> assertEquals(url,
                resolve(Map.of("QWEN_MANAGED_AGENT_SERVER_ADDRESS", address))
                        .get("serverUrl"), address));
        assertEquals("http://10.1.2.4:8080", resolve(Map.of(
                "SERVER_ADDRESS", "10.1.2.4")).get("serverUrl"));

        assertEquals("https://127.0.0.1:8443", resolve(Map.of(),
                "--server.port=8443", "--server.ssl.bundle=web")
                .get("serverUrl"));
        assertEquals("http://127.0.0.1:8080", resolve(Map.of(),
                "--server.ssl.enabled=false").get("serverUrl"));

        // 0 picks a port at start, and a negative one opens none.
        for (String port : new String[] {"0", "-1"}) {
            Map<String, String> resolved =
                    resolve(Map.of(), "--server.port=" + port);
            assertEquals("", resolved.get("serverUrl"), port);
            assertEquals("", resolved.get("healthUrl"), port);
        }
    }

    @Test
    void passesOnThePreflightsVerdictOnTheHarnessUrl() {
        // With the single Harness enabled, the preflight's harness row fails
        // each false one on its setting alone; the upgrade command refuses
        // start over them before it restarts the Harness.
        Map<String, String> verdicts = new LinkedHashMap<>();
        verdicts.put("http://127.0.0.1:4170", "true");
        verdicts.put("https://harness.internal:4170/base", "true");
        verdicts.put("http://[::1]:4170", "true");
        verdicts.put("http://qwen_harness:4170", "false");
        verdicts.put("http://@127.0.0.1:4170", "false");
        verdicts.put("http://svc:s3cret@127.0.0.1:4170", "false");
        verdicts.put("http://127.0.0.1:4170/?", "false");
        verdicts.put("http://127.0.0.1:4170#x", "false");
        verdicts.put("http://127.0.0.1:4170/a b", "false");
        verdicts.put("ftp://127.0.0.1:4170", "false");
        verdicts.put("", "false");
        verdicts.put(" http://127.0.0.1:4170 ", "false");
        verdicts.forEach((url, verdict) -> assertEquals(verdict, resolve(
                Map.of(), "--qwen.managed-agent.harness.enabled=true",
                "--qwen.managed-agent.harness.base-url=" + url)
                .get("harnessOrigin"), url));

        // Disabled, nothing reads the value: the Harness row skips before it
        // does, and the server never dials it.
        for (String url : new String[] {"http://qwen_harness:4170",
                " http://127.0.0.1:4170 ", "http://127.0.0.1:4170"}) {
            assertEquals("skip", resolve(Map.of(),
                    "--qwen.managed-agent.harness.base-url=" + url)
                    .get("harnessOrigin"), url);
            assertEquals("skip", resolve(Map.of(
                    "QWEN_MANAGED_AGENT_HARNESS_ENABLED", "false"),
                    "--qwen.managed-agent.harness.base-url=" + url)
                    .get("harnessOrigin"), url);
        }
        // Pooled, the row skips too, but each member's connector reads it.
        verdicts.forEach((url, verdict) -> assertEquals(verdict, resolve(
                Map.of("QWEN_MANAGED_AGENT_HARNESS_POOL_ENABLED", "true"),
                "--qwen.managed-agent.harness.enabled=true",
                "--qwen.managed-agent.harness.base-url=" + url)
                .get("harnessOrigin"), url));
    }

    @Test
    void judgesTheHarnessUrlAsTheConnectorThatDialsItDoes() {
        // The connector is built from the one base-url and refuses it by the
        // preflight's rule; a pool builds each member's connector from the
        // same value, as HarnessConfigurationTest pins.
        for (String url : new String[] {"http://127.0.0.1:4170",
                "https://harness.internal:4170/base", "http://[::1]:4170",
                "http://qwen_harness:4170", "http://@127.0.0.1:4170",
                "http://svc:s3cret@127.0.0.1:4170",
                "http://127.0.0.1:4170/?", "http://127.0.0.1:4170#x",
                "http://127.0.0.1:4170/a b", "ftp://127.0.0.1:4170",
                "proxy.test:4170", "", " http://127.0.0.1:4170 "}) {
            ManagedAgentProperties properties = new ManagedAgentProperties();
            ManagedAgentProperties.Harness harness = properties.getHarness();
            harness.setEnabled(true);
            harness.setBaseUrl(url);
            harness.setToken("token");
            harness.setCapabilityDigest("sha256:" + "a".repeat(64));
            boolean built;
            try {
                new QwenHostedHarnessConnector(properties,
                        mock(AgentStateStore.class),
                        mock(WorkspaceExecutionStore.class)).close();
                built = true;
            } catch (IllegalArgumentException | IllegalStateException refused) {
                built = false;
            }
            assertEquals(String.valueOf(built),
                    ManagedAgentPreflight.harnessUrlVerdict(harness), url);
        }
    }

    @Test
    void readsTheHealthEndpointAsSpringBootPlacesIt() {
        // A management port of its own binds every interface unless told
        // otherwise, whatever server.address says.
        Map<String, String> own = resolve(Map.of(
                "QWEN_MANAGED_AGENT_SERVER_ADDRESS", "10.1.2.3"),
                "--management.server.port=9091");
        assertEquals("http://10.1.2.3:8080", own.get("serverUrl"));
        assertEquals("http://127.0.0.1:9091/actuator/health",
                own.get("healthUrl"));
        // The server's own port, given again, shares its listener, where
        // the management base path does not apply.
        assertEquals("http://127.0.0.1:9090/actuator/health", resolve(Map.of(),
                "--server.port=9090", "--management.server.port=9090",
                "--management.server.base-path=/manage").get("healthUrl"));
        assertEquals("http://127.0.0.1:8080/actuator/health", resolve(Map.of(),
                "--management.server.port=8080").get("healthUrl"));
        for (String port : new String[] {"0", "-1"}) {
            assertEquals("", resolve(Map.of(),
                    "--management.server.port=" + port).get("healthUrl"), port);
        }
        assertEquals("http://[::1]:9091/manage/ops/healthz", resolve(Map.of(),
                "--management.server.port=9091",
                "--management.server.address=::1",
                "--management.server.base-path=manage/",
                "--management.endpoints.web.base-path=/ops/",
                "--management.endpoints.web.path-mapping.health=healthz")
                .get("healthUrl"));
        assertEquals("http://127.0.0.1:8080/health", resolve(Map.of(),
                "--management.endpoints.web.base-path=/").get("healthUrl"));
        // A blank mapping, such as an unset ${HEALTH_PATH:}, keeps the name.
        for (String mapping : new String[] {"", "   "}) {
            assertEquals("http://127.0.0.1:8080/actuator/health",
                    resolve(Map.of(),
                            "--management.endpoints.web.path-mapping.health="
                                    + mapping).get("healthUrl"),
                    "'" + mapping + "'");
        }

        // The server's TLS carries over unless management.server.ssl
        // replaces it.
        assertEquals("https://127.0.0.1:9091/actuator/health", resolve(Map.of(),
                "--server.ssl.bundle=web", "--management.server.port=9091")
                .get("healthUrl"));
        assertEquals("http://127.0.0.1:9091/actuator/health", resolve(Map.of(),
                "--server.ssl.bundle=web", "--management.server.port=9091",
                "--management.server.ssl.enabled=false").get("healthUrl"));
        assertEquals("https://127.0.0.1:9091/actuator/health", resolve(Map.of(),
                "--management.server.port=9091",
                "--management.server.ssl.bundle=ops").get("healthUrl"));
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
