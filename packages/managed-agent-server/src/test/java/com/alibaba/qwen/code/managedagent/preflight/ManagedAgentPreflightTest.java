package com.alibaba.qwen.code.managedagent.preflight;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.mock.env.MockEnvironment;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.file.Path;
import java.util.Base64;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
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
        assertEquals(ManagedAgentPreflight.Status.PASS,
                ManagedAgentPreflight.toolPathCheck(properties).status());
    }

    @Test
    void rejectsWorkspaceFilesWithoutAMountOrCreationRoot() {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getHarness().setEnabled(true);
        properties.getHarness().setWorkspaceFilesEnabled(true);
        properties.getHarness().setApprovalMode("yolo");
        properties.getSessionStore().setEnabled(true);
        properties.getRuntimeBroker().setEnabled(true);
        assertEquals(ManagedAgentPreflight.Status.FAIL,
                ManagedAgentPreflight.toolPathCheck(properties).status());
    }

    @Test
    void warnsWhenTheToolPathUsesAnotherProvisioner() {
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getHarness().setEnabled(true);
        properties.getHarness().setWorkspaceFilesEnabled(true);
        properties.getHarness().setApprovalMode("yolo");
        properties.getSessionStore().setEnabled(true);
        properties.getRuntimeBroker().setEnabled(true);
        properties.getRuntimeBroker().setProvisioner("static");
        assertEquals(ManagedAgentPreflight.Status.WARN,
                ManagedAgentPreflight.toolPathCheck(properties).status());
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
