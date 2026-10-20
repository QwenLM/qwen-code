package com.alibaba.qwen.code.managedagent.preflight;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.core.env.StandardEnvironment;
import org.springframework.mock.env.MockEnvironment;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ManagedAgentPreflightTest {
    private static final String DIGEST = "sha256:" + "a".repeat(64);

    @Test
    void treatsOnlyLoopbackSpellingsAsLoopback() {
        assertTrue(ManagedAgentPreflight.isLoopback("127.0.0.1"));
        assertTrue(ManagedAgentPreflight.isLoopback("::1"));
        assertTrue(ManagedAgentPreflight.isLoopback("localhost"));
        assertTrue(ManagedAgentPreflight.isLoopback(null));
        assertFalse(ManagedAgentPreflight.isLoopback("0.0.0.0"));
        assertFalse(ManagedAgentPreflight.isLoopback("10.0.0.1"));
    }

    @Test
    void acceptsOnlyLowercaseSha256Digests() {
        assertTrue(ManagedAgentPreflight.isDigest(DIGEST));
        assertFalse(ManagedAgentPreflight.isDigest(
                "sha256:" + "A".repeat(64)));
        assertFalse(ManagedAgentPreflight.isDigest("sha256:abc"));
    }

    @Test
    void requiresA32ByteCredentialKey() {
        assertTrue(ManagedAgentPreflight.isCredentialKey(encoded(32)));
        assertFalse(ManagedAgentPreflight.isCredentialKey(encoded(31)));
        assertFalse(ManagedAgentPreflight.isCredentialKey("not-base64"));
    }

    @Test
    void readsTheConfigLocationFromArgumentsBeforeTheEnvironment() {
        MockEnvironment environment = new MockEnvironment();
        environment.setProperty("SPRING_CONFIG_ADDITIONAL_LOCATION",
                "file:/from-env.yml");
        List<String> locations = ManagedAgentPreflight.configLocations(
                new String[] {"--spring.config.additional-location="
                        + "file:/from-arg.yml"}, environment);
        assertEquals(List.of("file:/from-arg.yml"), locations);
    }

    @Test
    void fallsBackToTheEnvironmentConfigLocation() {
        MockEnvironment environment = new MockEnvironment();
        environment.setProperty("SPRING_CONFIG_ADDITIONAL_LOCATION",
                "file:/from-env.yml,optional:file:/optional.yml");
        List<String> locations = ManagedAgentPreflight.configLocations(
                new String[0], environment);
        assertEquals(
                List.of("file:/from-env.yml", "optional:file:/optional.yml"),
                locations);
    }

    @Test
    void rejectsAutoModeOnANonLoopbackBind() {
        MockEnvironment environment = new MockEnvironment();
        environment.setProperty("server.address", "0.0.0.0");
        ManagedAgentPreflight.Check check = ManagedAgentPreflight.authCheck(
                environment, new ManagedAgentProperties());
        assertEquals(ManagedAgentPreflight.Status.FAIL, check.status());
    }

    @Test
    void requiresASigningKeyForSignedMode() {
        MockEnvironment environment = new MockEnvironment();
        environment.setProperty("server.address", "0.0.0.0");
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getAuth().setMode("signed");
        assertEquals(ManagedAgentPreflight.Status.FAIL,
                ManagedAgentPreflight.authCheck(environment, properties)
                        .status());
    }

    @Test
    void probesTheHarnessCapabilitiesEndpoint() throws IOException {
        HttpServer server = HttpServer.create(
                new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/capabilities", exchange -> {
            exchange.sendResponseHeaders(200, -1);
            exchange.close();
        });
        server.start();
        try {
            assertEquals(ManagedAgentPreflight.Status.PASS,
                    ManagedAgentPreflight.harnessCheck(harness(
                            "http://127.0.0.1:"
                                    + server.getAddress().getPort())).status());
        } finally {
            server.stop(0);
        }
    }

    @Test
    void failsWhenTheHarnessAnswersAnError() throws IOException {
        HttpServer server = HttpServer.create(
                new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/capabilities", exchange -> {
            exchange.sendResponseHeaders(503, -1);
            exchange.close();
        });
        server.start();
        try {
            assertEquals(ManagedAgentPreflight.Status.FAIL,
                    ManagedAgentPreflight.harnessCheck(harness(
                            "http://127.0.0.1:"
                                    + server.getAddress().getPort())).status());
        } finally {
            server.stop(0);
        }
    }

    @Test
    void sendsTheConfiguredHarnessToken() throws IOException {
        HttpServer server = HttpServer.create(
                new InetSocketAddress("127.0.0.1", 0), 0);
        AtomicReference<String> authorization = new AtomicReference<>();
        server.createContext("/capabilities", exchange -> {
            authorization.set(
                    exchange.getRequestHeaders().getFirst("Authorization"));
            exchange.sendResponseHeaders(200, -1);
            exchange.close();
        });
        server.start();
        try {
            assertEquals(ManagedAgentPreflight.Status.PASS,
                    ManagedAgentPreflight.harnessCheck(harness(
                            "http://127.0.0.1:"
                                    + server.getAddress().getPort())).status());
            assertEquals("Bearer token", authorization.get());
        } finally {
            server.stop(0);
        }
    }

    @Test
    void explainsARejectedHarnessToken() throws IOException {
        HttpServer server = HttpServer.create(
                new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/capabilities", exchange -> {
            exchange.sendResponseHeaders(401, -1);
            exchange.close();
        });
        server.start();
        try {
            ManagedAgentPreflight.Check check =
                    ManagedAgentPreflight.harnessCheck(harness(
                            "http://127.0.0.1:"
                                    + server.getAddress().getPort()));
            assertEquals(ManagedAgentPreflight.Status.FAIL, check.status());
            assertTrue(check.detail().contains("401"));
            assertTrue(check.fix().contains(
                    "QWEN_MANAGED_AGENT_HARNESS_TOKEN"));
        } finally {
            server.stop(0);
        }
    }

    @Test
    void failsWhenTheHarnessIsUnreachable() {
        assertEquals(ManagedAgentPreflight.Status.FAIL,
                ManagedAgentPreflight.harnessCheck(
                        harness("http://127.0.0.1:1")).status());
    }

    @Test
    void acceptsACompleteStaticBrokerConfiguration(@TempDir Path state) {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        ManagedAgentProperties.RuntimeBroker broker =
                properties.getRuntimeBroker();
        broker.setEnabled(true);
        broker.setToken("token");
        broker.setCredentialKeyId("reference-v1");
        broker.setCredentialKey(encoded(32));
        broker.setStateDirectory(state.toString());
        broker.setProvisioner("static");
        broker.setStaticEndpoint("http://127.0.0.1:1");
        broker.setStaticToken("token");
        List<ManagedAgentPreflight.Check> checks =
                ManagedAgentPreflight.brokerChecks(properties);
        assertTrue(checks.stream().noneMatch(check ->
                check.status() == ManagedAgentPreflight.Status.FAIL));
    }

    @Test
    void rejectsAnUndersizedCredentialKey(@TempDir Path state) {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        ManagedAgentProperties.RuntimeBroker broker =
                properties.getRuntimeBroker();
        broker.setEnabled(true);
        broker.setToken("token");
        broker.setCredentialKeyId("reference-v1");
        broker.setCredentialKey(encoded(31));
        broker.setStateDirectory(state.toString());
        broker.setProvisioner("static");
        broker.setStaticEndpoint("http://127.0.0.1:1");
        broker.setStaticToken("token");
        List<ManagedAgentPreflight.Check> checks =
                ManagedAgentPreflight.brokerChecks(properties);
        assertTrue(checks.stream().anyMatch(check ->
                check.status() == ManagedAgentPreflight.Status.FAIL));
    }

    @Test
    void treatsAMissingOptionalConfigAsAWarning() {
        assertEquals(ManagedAgentPreflight.Status.WARN,
                ManagedAgentPreflight.configFileCheck(
                        List.of("optional:file:/does-not-exist/"
                                + "application.yml")).status());
    }

    @Test
    void treatsAMissingRequiredConfigAsAFailure() {
        assertEquals(ManagedAgentPreflight.Status.FAIL,
                ManagedAgentPreflight.configFileCheck(
                        List.of("file:/does-not-exist/application.yml"))
                        .status());
    }

    @Test
    void requiresTheSessionStoreForWorkspaceFiles() {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getHarness().setEnabled(true);
        properties.getHarness().setWorkspaceFilesEnabled(true);
        properties.getHarness().setApprovalMode("yolo");
        properties.getSessionStore().setEnabled(false);
        properties.getRuntimeBroker().setEnabled(true);
        assertEquals(ManagedAgentPreflight.Status.FAIL,
                ManagedAgentPreflight.toolPathCheck(properties).status());
    }

    @Test
    void acceptsWorkspaceFilesWhenBothServicesAreEnabled() {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getHarness().setEnabled(true);
        properties.getHarness().setWorkspaceFilesEnabled(true);
        properties.getHarness().setApprovalMode("yolo");
        properties.getSessionStore().setEnabled(true);
        properties.getRuntimeBroker().setEnabled(true);
        properties.getRuntimeBroker()
                .setWorkspaceCreationRoot("/tmp/workspace-root");
        properties.getRuntimeBroker()
                .setVerifiedWorkspaceRecoveryEnabled(true);
        assertEquals(ManagedAgentPreflight.Status.PASS,
                ManagedAgentPreflight.toolPathCheck(properties).status());
    }

    @Test
    void rejectsWorkspaceFilesWithoutAMountOrCreationRoot() {
        ManagedAgentProperties properties = toolProperties();
        assertEquals(ManagedAgentPreflight.Status.FAIL,
                ManagedAgentPreflight.toolPathCheck(properties).status());
    }

    @Test
    void rejectsWorkspaceCreationWithoutVerifiedRecovery() {
        ManagedAgentProperties properties = toolProperties();
        properties.getRuntimeBroker()
                .setWorkspaceCreationRoot("/tmp/workspace-root");
        assertEquals(ManagedAgentPreflight.Status.FAIL,
                ManagedAgentPreflight.toolPathCheck(properties).status());
    }

    @Test
    void warnsWhenTheToolPathUsesAnotherProvisioner() {
        ManagedAgentProperties properties = toolProperties();
        properties.getRuntimeBroker().setProvisioner("kubernetes-workspace");
        assertEquals(ManagedAgentPreflight.Status.WARN,
                ManagedAgentPreflight.toolPathCheck(properties).status());
    }

    @Test
    void rejectsWorkspaceFilesWithTheStaticProvisioner() {
        ManagedAgentProperties properties = toolProperties();
        properties.getRuntimeBroker().setProvisioner("static");
        assertEquals(ManagedAgentPreflight.Status.FAIL,
                ManagedAgentPreflight.toolPathCheck(properties).status());
    }

    @Test
    void rejectsSshWithoutNodes() {
        ManagedAgentProperties properties = toolProperties();
        properties.getRuntimeBroker().setWorkspaceMounts(List.of(
                new ManagedAgentProperties.RuntimeBroker.WorkspaceMount(
                        "tenant-1", "storage-1", "/tmp/workspace-mount")));
        properties.getRuntimeBroker().getSsh().setEnabled(true);
        ManagedAgentPreflight.Check check =
                ManagedAgentPreflight.toolPathCheck(properties);
        assertEquals(ManagedAgentPreflight.Status.FAIL, check.status());
        assertTrue(check.detail().contains("SSH Runtime"));
    }

    @Test
    void rejectsWorkspaceCreationWithoutWorkspaceFiles() {
        ManagedAgentProperties properties = toolProperties();
        properties.getHarness().setWorkspaceFilesEnabled(false);
        properties.getRuntimeBroker()
                .setWorkspaceCreationRoot("/tmp/workspace-root");
        assertEquals(ManagedAgentPreflight.Status.FAIL,
                ManagedAgentPreflight.toolPathCheck(properties).status());
    }

    @Test
    void rejectsAnUnsupportedIsolationClass() {
        ManagedAgentProperties properties = toolProperties();
        properties.getRuntimeBroker()
                .setWorkspaceCreationRoot("/tmp/workspace-root");
        properties.getRuntimeBroker()
                .setVerifiedWorkspaceRecoveryEnabled(true);
        properties.getRuntimeBroker().setIsolationClass("tenant");
        assertEquals(ManagedAgentPreflight.Status.FAIL,
                ManagedAgentPreflight.toolPathCheck(properties).status());
    }

    @Test
    void commandLineArgumentsOverrideTheEnvironment() {
        var environment = ManagedAgentPreflight.baseEnvironment(new String[] {
                "--server.address=0.0.0.0",
                "--qwen.managed-agent.auth.mode=open"});
        assertEquals("0.0.0.0", environment.getProperty("server.address"));
        assertEquals("open",
                environment.getProperty("qwen.managed-agent.auth.mode"));
    }

    @Test
    void laterExternalYamlOverridesEarlierWithoutDroppingKeys(
            @TempDir Path directory) throws IOException {
        Path first = Files.writeString(directory.resolve("first.yml"),
                "server:\n  address: 0.0.0.0\n");
        Path second = Files.writeString(directory.resolve("second.yml"),
                "server:\n  port: 0\n");
        var environment = new StandardEnvironment();
        ManagedAgentPreflight.loadConfiguration(environment,
                List.of(first.toString(), second.toString()),
                new ArrayList<>());
        assertEquals("0.0.0.0", environment.getProperty("server.address"));
        assertEquals("0", environment.getProperty("server.port"));
    }

    @Test
    void rejectsAMissingPerformanceSchemaGrant() {
        MockEnvironment environment = new MockEnvironment();
        environment.setProperty("spring.datasource.url",
                "jdbc:h2:mem:preflight-grant;DB_CLOSE_DELAY=-1");
        environment.setProperty("spring.datasource.username", "sa");
        environment.setProperty("spring.datasource.password", "");
        ManagedAgentPreflight.Check check =
                ManagedAgentPreflight.databaseCheck(environment);
        assertEquals(ManagedAgentPreflight.Status.FAIL, check.status());
        assertTrue(check.detail().contains("performance_schema grant missing"));
    }

    @Test
    void findsTheManifestBesideTheOuterJar(@TempDir Path distribution)
            throws IOException {
        Path lib = Files.createDirectories(distribution.resolve("lib"));
        Path jar = Files.writeString(lib.resolve("server.jar"), "server");
        Path manifest = distribution.resolve("manifest.json");
        Files.writeString(manifest,
                "{\"compatibility\":{\"databaseSchema\":"
                        + "{\"latestMigrationVersion\":\"999\"}}}");
        assertEquals(manifest,
                ManagedAgentPreflight.findManifest(jar.toString()));
        Path relative = Path.of("").toAbsolutePath()
                .relativize(jar.toAbsolutePath());
        assertEquals(manifest,
                ManagedAgentPreflight.findManifest(relative.toString()));
        assertEquals("999",
                ManagedAgentPreflight.expectedSchemaVersion(manifest));
    }

    @Test
    void rejectsOpenModeOnANonLoopbackBind() {
        MockEnvironment environment = new MockEnvironment();
        environment.setProperty("server.address", "0.0.0.0");
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getAuth().setMode("open");
        assertEquals(ManagedAgentPreflight.Status.FAIL,
                ManagedAgentPreflight.authCheck(environment, properties)
                        .status());
    }

    @Test
    void rejectsAContextPath() {
        MockEnvironment environment = new MockEnvironment();
        environment.setProperty("server.address", "127.0.0.1");
        environment.setProperty("server.servlet.context-path", "/prefix");
        assertEquals(ManagedAgentPreflight.Status.FAIL,
                ManagedAgentPreflight.authCheck(environment,
                        new ManagedAgentProperties()).status());
    }

    @Test
    void rejectsAServletPath() {
        MockEnvironment environment = new MockEnvironment();
        environment.setProperty("server.address", "127.0.0.1");
        environment.setProperty("spring.mvc.servlet.path", "/api");
        assertEquals(ManagedAgentPreflight.Status.FAIL,
                ManagedAgentPreflight.authCheck(environment,
                        new ManagedAgentProperties()).status());
    }

    @Test
    void acceptsAutoModeOnANonLoopbackBindWithInsecureOverride() {
        MockEnvironment environment = new MockEnvironment();
        environment.setProperty("server.address", "0.0.0.0");
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getAuth().setMode("auto");
        properties.getAuth().setAllowInsecureBind(true);
        assertNotEquals(ManagedAgentPreflight.Status.FAIL,
                ManagedAgentPreflight.authCheck(environment, properties)
                        .status());
    }

    @Test
    void rejectsAnUnknownAuthMode() {
        MockEnvironment environment = new MockEnvironment();
        environment.setProperty("server.address", "0.0.0.0");
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getAuth().setMode("typo");
        assertEquals(ManagedAgentPreflight.Status.FAIL,
                ManagedAgentPreflight.authCheck(environment, properties)
                        .status());
    }

    @Test
    void rejectsAShortSigningKey() {
        MockEnvironment environment = new MockEnvironment();
        environment.setProperty("server.address", "0.0.0.0");
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getAuth().setMode("signed");
        properties.getAuth().setSigningKey("x".repeat(31));
        assertEquals(ManagedAgentPreflight.Status.FAIL,
                ManagedAgentPreflight.authCheck(environment, properties)
                        .status());
    }

    @Test
    void acceptsTheDefaultStartupProperties() {
        assertEquals(ManagedAgentPreflight.Status.PASS,
                ManagedAgentPreflight.startupValidationCheck(
                        new ManagedAgentProperties()).status());
    }

    @Test
    void rejectsAnOutOfRangeApprovalTimeout() {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getHarness().setApprovalTimeout(Duration.ofMillis(500));
        assertEquals(ManagedAgentPreflight.Status.FAIL,
                ManagedAgentPreflight.startupValidationCheck(properties)
                        .status());
    }

    @Test
    void rejectsAnInvalidBoundSessionIsolation() {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getRuntimeBroker().setBoundSessionIsolationClass("tenant");
        assertEquals(ManagedAgentPreflight.Status.FAIL,
                ManagedAgentPreflight.startupValidationCheck(properties)
                        .status());
    }

    @Test
    void rejectsSshWithoutWorkspaceFiles() {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getRuntimeBroker().getSsh().setEnabled(true);
        assertEquals(ManagedAgentPreflight.Status.FAIL,
                ManagedAgentPreflight.startupValidationCheck(properties)
                        .status());
    }

    private static ManagedAgentProperties toolProperties() {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getHarness().setEnabled(true);
        properties.getHarness().setWorkspaceFilesEnabled(true);
        properties.getHarness().setApprovalMode("yolo");
        properties.getSessionStore().setEnabled(true);
        properties.getRuntimeBroker().setEnabled(true);
        return properties;
    }

    private static ManagedAgentProperties harness(String baseUrl) {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getHarness().setEnabled(true);
        properties.getHarness().setToken("token");
        properties.getHarness().setCapabilityDigest(DIGEST);
        properties.getHarness().setBaseUrl(baseUrl);
        return properties;
    }

    private static String encoded(int bytes) {
        return Base64.getEncoder().encodeToString(new byte[bytes]);
    }
}
