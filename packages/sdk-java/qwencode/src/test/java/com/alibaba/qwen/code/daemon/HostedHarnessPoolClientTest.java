package com.alibaba.qwen.code.daemon;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import com.sun.net.httpserver.HttpsConfigurator;
import com.sun.net.httpserver.HttpsServer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManagerFactory;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.time.Duration;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class HostedHarnessPoolClientTest {
    private static final String BOOT = UUID.randomUUID().toString();
    private static final String SESSION = UUID.randomUUID().toString();
    private static final String OPERATION = UUID.randomUUID().toString();
    private static final String DIGEST = "sha256:" + "a".repeat(64);

    @Test
    void placementSurvivesEveryLoadCopyWithoutChangingLegacyRequests() {
        var placement = new HostedHarnessPlacement("instance-a", BOOT, 7);
        assertEquals(placement.toJson(), CreateHarnessSession.builder().harnessSessionId(SESSION)
                .harnessPlacement(placement).build().toJson().get("harnessPlacement"));
        assertFalse(CreateHarnessSession.builder().harnessSessionId(SESSION).build().toJson().containsKey("harnessPlacement"));
        var loaded = new LoadHarnessSession(SESSION).withHarnessPlacement(placement)
                .withChildWorkspaces(true).withForegroundOnly(true).withStoppedMessages().forLifecycle("close", 1);
        assertEquals(placement.toJson(), loaded.toJson().get("harnessPlacement"));
        assertFalse(new LoadHarnessSession(SESSION).toJson().containsKey("harnessPlacement"));
        assertThrows(IllegalArgumentException.class, () -> new HostedHarnessPlacement("instance", BOOT, 0));
    }

    @Test
    void instanceAndDrainUsePinnedBootAndDoNotAcquireSessions() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        var drainBody = new AtomicReference<Map<String, Object>>();
        server.createContext("/capabilities", exchange -> send(exchange, capabilities()));
        server.createContext("/internal/hosted-harness/v1/instance", exchange -> send(exchange, instance("ACCEPTING")));
        server.createContext("/internal/hosted-harness/v1/instance:drain", exchange -> {
            assertEquals(BOOT, exchange.getRequestHeaders().getFirst("X-Qwen-Harness-Boot-Id"));
            drainBody.set(JsonSupport.parseObject(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8), "drain"));
            send(exchange, instance("QUIESCING"));
        });
        server.start();
        try (var client = builder(URI.create("http://127.0.0.1:" + server.getAddress().getPort())).build()) {
            assertEquals("instance-a", client.capabilities().getInstanceId());
            assertEquals("ACCEPTING", client.readInstance().get("state"));
            assertEquals("QUIESCING", client.drainInstance(OPERATION).get("state"));
            assertEquals(Map.of("operationId", OPERATION, "expectedBootId", BOOT), drainBody.get());
        } finally {
            server.stop(0);
        }
    }

    @Test
    void releaseChecksItsEpochAndCommittedPrefix() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        var response = new AtomicReference<>(release(7, "a".repeat(64)));
        server.createContext("/capabilities", exchange -> send(exchange, capabilities()));
        server.createContext("/session/" + SESSION + "/ownership:release", exchange -> send(exchange, response.get()));
        server.start();
        try (var client = builder(URI.create("http://127.0.0.1:" + server.getAddress().getPort())).build()) {
            var ref = new HarnessSessionRef(SESSION, "client-a", BOOT, "/tmp", null, 0L, null);
            assertEquals("RELEASED", client.releaseOwnership(ref, OPERATION, 7).get("state"));
            response.set(release(8, "a".repeat(64)));
            assertThrows(MutationOutcomeUnknownException.class, () -> client.releaseOwnership(ref, OPERATION, 7));
            response.set(release(7, "invalid-hash"));
            assertThrows(MutationOutcomeUnknownException.class, () -> client.releaseOwnership(ref, OPERATION, 7));
        } finally {
            server.stop(0);
        }
    }

    @Test
    void explicitTlsContextAuthenticatesPeerAndKeepsHostnameVerification(@TempDir Path directory) throws Exception {
        Path storeFile = directory.resolve("identity.p12");
        var process = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "keytool").toString(),
                "-genkeypair", "-alias", "test", "-keyalg", "RSA", "-keysize", "2048", "-validity", "2",
                "-dname", "CN=Harness test", "-ext", "SAN=IP:127.0.0.1", "-storetype", "PKCS12",
                "-keystore", storeFile.toString(), "-storepass", "test-password", "-keypass", "test-password", "-noprompt")
                .redirectErrorStream(true).start();
        assertTrue(process.waitFor(20, TimeUnit.SECONDS));
        assertEquals(0, process.exitValue());
        KeyStore store = KeyStore.getInstance("PKCS12");
        try (var input = Files.newInputStream(storeFile)) {
            store.load(input, "test-password".toCharArray());
        }
        var keys = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
        keys.init(store, "test-password".toCharArray());
        var trust = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        trust.init(store);
        SSLContext identity = SSLContext.getInstance("TLS");
        identity.init(keys.getKeyManagers(), trust.getTrustManagers(), null);
        SSLContext trustOnly = SSLContext.getInstance("TLS");
        trustOnly.init(null, trust.getTrustManagers(), null);
        HttpsServer server = HttpsServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.setHttpsConfigurator(new HttpsConfigurator(identity) {
            @Override
            public void configure(com.sun.net.httpserver.HttpsParameters parameters) {
                var ssl = getSSLContext().getDefaultSSLParameters();
                ssl.setNeedClientAuth(true);
                parameters.setSSLParameters(ssl);
            }
        });
        server.createContext("/capabilities", exchange -> send(exchange, capabilities()));
        server.start();
        URI valid = URI.create("https://127.0.0.1:" + server.getAddress().getPort());
        try {
            try (var client = builder(valid).sslContext(identity).build()) {
                assertEquals(BOOT, client.capabilities().getBootId());
            }
            assertThrows(DaemonTransportException.class, () -> builder(valid).sslContext(trustOnly).build());
            assertThrows(DaemonTransportException.class,
                    () -> builder(URI.create("https://localhost:" + server.getAddress().getPort())).sslContext(identity).build());
        } finally {
            server.stop(0);
        }
    }

    private static HostedHarnessClient.Builder builder(URI uri) {
        return HostedHarnessClient.builder().baseUri(uri).bearerToken("test-token").capabilityDigest(DIGEST)
                .connectTimeout(Duration.ofSeconds(2)).requestTimeout(Duration.ofSeconds(3)).heartbeatInterval(Duration.ZERO);
    }

    private static String capabilities() {
        return "{\"v\":1,\"features\":[\"hosted_harness_private_v1\",\"managed_session_journal_delta_v1\"],"
                + "\"transports\":[\"rest\"],\"hostedHarness\":{\"protocolVersions\":{\"current\":1,\"supported\":[1]},"
                + "\"bootId\":\"" + BOOT + "\",\"instanceId\":\"instance-a\",\"capabilityDigest\":\"" + DIGEST
                + "\",\"features\":[\"harness-pool-owner/1\",\"harness-instance-lifecycle/1\"]}}";
    }

    private static String instance(String state) {
        return "{\"format\":\"qwen-hosted-harness-instance/1\",\"instanceId\":\"instance-a\",\"bootId\":\"" + BOOT
                + "\",\"capabilityDigest\":\"" + DIGEST + "\",\"state\":\"" + state + "\",\"counters\":{"
                + "\"attachedSessions\":0,\"activeTurns\":0,\"openingSessions\":0,\"pendingInputs\":0,"
                + "\"heldResources\":0,\"pendingPublications\":0,\"inFlightMutations\":0}}";
    }

    private static String release(long epoch, String hash) {
        return "{\"format\":\"qwen-hosted-harness-release/1\",\"instanceId\":\"instance-a\",\"bootId\":\"" + BOOT
                + "\",\"operationId\":\"" + OPERATION + "\",\"placementEpoch\":" + epoch
                + ",\"sessionId\":\"" + SESSION + "\",\"writerGeneration\":1,\"journalRevision\":2,\"committedSequence\":3,"
                + "\"commitProof\":{\"lastCommitSequence\":3,\"committedPrefixHash\":\"" + hash + "\"},\"state\":\"RELEASED\"}";
    }

    private static void send(HttpExchange exchange, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.getResponseHeaders().set("X-Qwen-Harness-Boot-Id", BOOT);
        exchange.sendResponseHeaders(exchange.getRequestURI().getPath().endsWith(":drain") ? 202 : 200, bytes.length);
        exchange.getResponseBody().write(bytes);
        exchange.close();
    }
}
