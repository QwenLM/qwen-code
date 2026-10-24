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
import java.sql.Connection;
import java.sql.DriverManager;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
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
    void reportsDurableCapacityStatesWithoutClaimingPhysicalResources()
            throws Exception {
        try (Connection connection = DriverManager.getConnection(
                "jdbc:h2:mem:preflight-capacity;DB_CLOSE_DELAY=-1")) {
            try (var statement = connection.createStatement()) {
                statement.execute("CREATE TABLE ma_runtime_binding "
                        + "(binding_state VARCHAR(32))");
                statement.execute("CREATE TABLE ma_runtime_session "
                        + "(session_state VARCHAR(32))");
                statement.execute("CREATE TABLE ma_operation "
                        + "(state VARCHAR(32))");
                statement.execute("INSERT INTO ma_runtime_binding VALUES "
                        + "('READY'), ('READY'), ('DRAINING')");
                statement.execute("INSERT INTO ma_runtime_session VALUES "
                        + "('READY'), ('RELEASED')");
                statement.execute("INSERT INTO ma_operation VALUES "
                        + "('PENDING'), ('COMPLETED')");
            }

            ManagedAgentPreflight.Check check =
                    ManagedAgentPreflight.capacityCheck(connection);

            assertEquals(ManagedAgentPreflight.Status.PASS, check.status());
            assertTrue(check.detail().contains("READY=2"));
            assertTrue(check.detail().contains("PENDING=1"));
            assertTrue(check.detail().contains("physical-processes=unknown"));
            assertTrue(check.detail().contains("memory=unknown"));
            assertTrue(check.detail().contains(
                    "idle-reclamation=not measured"));
        }
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
    void explainsARejectedHarnessToken(@TempDir Path directory)
            throws IOException {
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
            Path file = credentialsFile(directory, "f".repeat(64), DIGEST);
            ManagedAgentProperties fromFile = fromFile(file,
                    "http://127.0.0.1:" + server.getAddress().getPort());
            assertEquals("set QWEN_SERVER_TOKEN in " + file + " to the"
                    + " token the Harness accepts",
                    ManagedAgentPreflight.harnessCheck(fromFile).fix());
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
    void reportsTheEffectiveSessionStoreWiring() {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getSessionStore().setEnabled(true);
        assertEquals(ManagedAgentPreflight.Status.SKIP,
                ManagedAgentPreflight.sessionStoreCheck(properties).status());
        properties.getHarness().setEnabled(true);
        ManagedAgentPreflight.Check url =
                ManagedAgentPreflight.sessionStoreCheck(properties);
        assertEquals(ManagedAgentPreflight.Status.FAIL, url.status());
        assertTrue(url.fix().contains(
                "QWEN_MANAGED_AGENT_SESSION_STORE_BASE_URL"));
        properties.getSessionStore().setBaseUrl("http://127.0.0.1:8080");
        ManagedAgentPreflight.Check workspace =
                ManagedAgentPreflight.sessionStoreCheck(properties);
        assertEquals(ManagedAgentPreflight.Status.FAIL, workspace.status());
        assertTrue(workspace.fix().contains(
                "QWEN_MANAGED_AGENT_WORKSPACE_CWD"));
        properties.getSessionStore().setWorkspaceId("workspace");
        assertEquals(ManagedAgentPreflight.Status.PASS,
                ManagedAgentPreflight.sessionStoreCheck(properties).status());
        properties.getSessionStore().setEnabled(false);
        assertEquals(ManagedAgentPreflight.Status.SKIP,
                ManagedAgentPreflight.sessionStoreCheck(properties).status());
    }

    @Test
    void derivesTheSessionStoreWiringFromTheShippedDefaults(
            @TempDir Path workspace) throws IOException {
        var environment = new StandardEnvironment();
        environment.getPropertySources().addFirst(
                new org.springframework.core.env.MapPropertySource("test",
                        java.util.Map.of(
                                "QWEN_MANAGED_AGENT_HARNESS_ENABLED", "true",
                                "QWEN_MANAGED_AGENT_WORKSPACE_CWD",
                                workspace.toString(),
                                "server.port", "9090")));
        List<ManagedAgentPreflight.Check> checks = new ArrayList<>();
        ManagedAgentPreflight.loadConfiguration(environment, List.of(),
                checks);
        ManagedAgentProperties properties =
                ManagedAgentPreflight.bind(environment, checks);
        assertTrue(checks.isEmpty(), checks.toString());
        ManagedAgentPreflight.startupValidationCheck(properties);
        ManagedAgentPreflight.Check check =
                ManagedAgentPreflight.sessionStoreCheck(properties);
        assertEquals(ManagedAgentPreflight.Status.PASS, check.status());
        assertEquals("http://127.0.0.1:9090",
                properties.getSessionStore().getBaseUrl());
        assertEquals(org.apache.commons.codec.digest.DigestUtils.sha256Hex(
                        workspace.toRealPath().toString().getBytes(
                                java.nio.charset.StandardCharsets.UTF_8))
                        .substring(0, 16),
                properties.getSessionStore().getWorkspaceId());
    }

    @Test
    void failsTheDerivedStoreUrlOfATlsListener(@TempDir Path workspace) {
        var environment = new StandardEnvironment();
        environment.getPropertySources().addFirst(
                new org.springframework.core.env.MapPropertySource("test",
                        java.util.Map.of(
                                "QWEN_MANAGED_AGENT_HARNESS_ENABLED", "true",
                                "QWEN_MANAGED_AGENT_WORKSPACE_CWD",
                                workspace.toString(),
                                "server.ssl.bundle", "web")));
        List<ManagedAgentPreflight.Check> checks = new ArrayList<>();
        ManagedAgentPreflight.loadConfiguration(environment, List.of(),
                checks);
        ManagedAgentProperties properties =
                ManagedAgentPreflight.bind(environment, checks);
        ManagedAgentPreflight.startupValidationCheck(properties);
        ManagedAgentPreflight.Check check =
                ManagedAgentPreflight.sessionStoreCheck(properties);
        assertEquals(ManagedAgentPreflight.Status.FAIL, check.status());
        assertEquals("base URL is empty", check.detail());
    }

    @Test
    void warnsWhenTheHarnessCredentialsFileIsShared(@TempDir Path directory)
            throws IOException {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        Path file = Files.writeString(directory.resolve("harness.env"), "");
        properties.getHarness().setCredentialsFile(file.toString());
        assertEquals("disabled",
                ManagedAgentPreflight.credentialsFileCheck(properties).detail());
        properties.getHarness().setEnabled(true);
        properties.getHarness().setCredentialsFile("");
        assertEquals("no Harness credentials configured",
                ManagedAgentPreflight.credentialsFileCheck(properties).detail());
        properties.getHarness().setCredentialsFile(file.toString());
        Files.setPosixFilePermissions(file,
                java.nio.file.attribute.PosixFilePermissions.fromString("rw-------"));
        assertEquals(ManagedAgentPreflight.Status.PASS,
                ManagedAgentPreflight.credentialsFileCheck(properties).status());
        Files.setPosixFilePermissions(file,
                java.nio.file.attribute.PosixFilePermissions.fromString("rw-r-----"));
        ManagedAgentPreflight.Check shared =
                ManagedAgentPreflight.credentialsFileCheck(properties);
        assertEquals(ManagedAgentPreflight.Status.WARN, shared.status());
        assertEquals("chmod 600 " + file, shared.fix());
        Files.setPosixFilePermissions(file,
                java.nio.file.attribute.PosixFilePermissions.fromString("rw----r--"));
        ManagedAgentPreflight.Check world =
                ManagedAgentPreflight.credentialsFileCheck(properties);
        assertEquals(ManagedAgentPreflight.Status.WARN, world.status());
        assertEquals("chmod 600 " + file, world.fix());
        // The server reads it at startup, so an unreadable file fails.
        properties.getHarness().setCredentialsFile(
                directory.resolve("missing.env").toString());
        ManagedAgentPreflight.Check missing =
                ManagedAgentPreflight.credentialsFileCheck(properties);
        assertEquals(ManagedAgentPreflight.Status.FAIL, missing.status());
        assertTrue(missing.fix().startsWith("chown it to the service account"));
        // An unusable path reports a row instead of ending the run.
        properties.getHarness().setCredentialsFile("/etc/qwen\0managed.env");
        assertEquals(ManagedAgentPreflight.Status.WARN,
                ManagedAgentPreflight.credentialsFileCheck(properties).status());
    }

    @Test
    void warnsWhenAConfigFileWithSecretsIsShared(@TempDir Path directory)
            throws IOException {
        Path file = Files.writeString(directory.resolve("application.yml"),
                "qwen:\n  managed-agent:\n    runtime-broker:\n"
                        + "      credential-key: 'x'\n");
        Files.setPosixFilePermissions(file,
                java.nio.file.attribute.PosixFilePermissions.fromString("rw-r-----"));
        ManagedAgentPreflight.Check shared = ManagedAgentPreflight
                .configFileCheck(List.of("file:" + file));
        assertEquals(ManagedAgentPreflight.Status.WARN, shared.status());
        assertEquals("chmod 600 " + file, shared.fix());
        Files.setPosixFilePermissions(file,
                java.nio.file.attribute.PosixFilePermissions.fromString("rw-------"));
        assertEquals(ManagedAgentPreflight.Status.PASS, ManagedAgentPreflight
                .configFileCheck(List.of("file:" + file)).status());
    }

    @Test
    void sendsTheTokenTheStartupValidationReadFromTheFile(
            @TempDir Path directory) throws IOException {
        String token = "f".repeat(64);
        Path file = credentialsFile(directory, token, DIGEST);
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
            ManagedAgentProperties properties = new ManagedAgentProperties();
            properties.getHarness().setEnabled(true);
            properties.getSessionStore().setEnabled(true);
            properties.getHarness().setCredentialsFile(file.toString());
            properties.getHarness().setBaseUrl(
                    "http://127.0.0.1:" + server.getAddress().getPort());
            // run() adds the validation row before the Harness row.
            assertEquals(ManagedAgentPreflight.Status.PASS,
                    ManagedAgentPreflight.startupValidationCheck(properties)
                            .status());
            assertEquals(ManagedAgentPreflight.Status.PASS,
                    ManagedAgentPreflight.harnessCheck(properties).status());
            assertEquals("Bearer " + token, authorization.get());
            // A direct token beside the file is refused, so it is not sent.
            authorization.set(null);
            ManagedAgentProperties conflicting = new ManagedAgentProperties();
            conflicting.getHarness().setEnabled(true);
            conflicting.getSessionStore().setEnabled(true);
            conflicting.getHarness().setCredentialsFile(file.toString());
            conflicting.getHarness().setToken("e".repeat(64));
            conflicting.getHarness().setBaseUrl(
                    "http://127.0.0.1:" + server.getAddress().getPort());
            assertEquals(ManagedAgentPreflight.Status.FAIL,
                    ManagedAgentPreflight.startupValidationCheck(conflicting)
                            .status());
            ManagedAgentPreflight.Check skipped =
                    ManagedAgentPreflight.harnessCheck(conflicting);
            assertEquals(ManagedAgentPreflight.Status.SKIP, skipped.status());
            assertEquals("credentials were not read from " + file
                    + "; see the validation row", skipped.detail());
            assertNull(authorization.get());
        } finally {
            server.stop(0);
        }
    }

    @Test
    void listsTheCredentialsRowAfterTheHarnessRow(@TempDir Path directory)
            throws IOException {
        Path file = credentialsFile(directory, "f".repeat(64), DIGEST);
        Files.setPosixFilePermissions(file,
                java.nio.file.attribute.PosixFilePermissions.fromString("rw-------"));
        List<ManagedAgentPreflight.Check> checks = ManagedAgentPreflight
                .checks(new String[] {
                    "--qwen.managed-agent.harness.enabled=true",
                    "--qwen.managed-agent.harness.credentials-file=" + file,
                    "--qwen.managed-agent.harness.token=" + "e".repeat(64),
                    "--qwen.managed-agent.runtime-broker.enabled=false",
                    "--server.port=0",
                    "--spring.datasource.url=",
                });
        List<String> rows = checks.stream()
                .map(ManagedAgentPreflight.Check::name).toList();
        int harness = rows.indexOf("harness");
        assertEquals(harness + 1, rows.indexOf("credentials"), rows.toString());
        assertEquals(ManagedAgentPreflight.Status.FAIL,
                checks.get(rows.indexOf("validation")).status());
        assertEquals(ManagedAgentPreflight.Status.SKIP,
                checks.get(harness).status());
        assertEquals(ManagedAgentPreflight.Status.PASS,
                checks.get(harness + 1).status());
    }

    @Test
    void refusesTheShippedPlaceholderToken() {
        ManagedAgentProperties properties = harness("http://127.0.0.1:1");
        properties.getHarness().setToken("replace-with-a-private-random-token");
        ManagedAgentPreflight.Check check =
                ManagedAgentPreflight.harnessCheck(properties);
        assertEquals(ManagedAgentPreflight.Status.FAIL, check.status());
        assertEquals("token is still the shipped template placeholder",
                check.detail());
    }

    @Test
    void pointsHarnessCredentialFixesAtTheCredentialsFile(
            @TempDir Path directory) throws IOException {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getHarness().setEnabled(true);
        assertEquals("set QWEN_MANAGED_AGENT_HARNESS_TOKEN",
                ManagedAgentPreflight.harnessCheck(properties).fix());
        properties.getHarness().setToken("token");
        assertEquals("set QWEN_MANAGED_AGENT_CAPABILITY_DIGEST",
                ManagedAgentPreflight.harnessCheck(properties).fix());
        Path placeholderToken = credentialsFile(directory,
                "replace-with-a-private-random-token", DIGEST);
        assertEquals("set QWEN_SERVER_TOKEN in " + placeholderToken,
                ManagedAgentPreflight.harnessCheck(
                        fromFile(placeholderToken, "http://127.0.0.1:1")).fix());
        Path placeholderDigest = credentialsFile(directory, "token",
                "sha256:replace-with-64-lowercase-hex");
        assertEquals("set QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST in "
                + placeholderDigest,
                ManagedAgentPreflight.harnessCheck(
                        fromFile(placeholderDigest, "http://127.0.0.1:1")).fix());
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

    private static Path credentialsFile(Path directory, String token,
            String digest) throws IOException {
        return Files.writeString(Files.createTempFile(directory, "harness", ".env"),
                "QWEN_SERVER_TOKEN=" + token
                        + "\nQWEN_HOSTED_HARNESS_CAPABILITY_DIGEST=" + digest
                        + "\n");
    }

    // Binds the file the way startup validation does before run()'s
    // Harness row.
    private static ManagedAgentProperties fromFile(Path file, String baseUrl) {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getHarness().setEnabled(true);
        properties.getSessionStore().setEnabled(true);
        properties.getHarness().setCredentialsFile(file.toString());
        properties.getHarness().setBaseUrl(baseUrl);
        properties.validateForPreflight();
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
