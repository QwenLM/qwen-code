package com.alibaba.qwen.code.managedagent.extensions;

import com.alibaba.qwen.code.managedagent.adapters.extensions.DirectoryExtensionArchiveStorage;
import com.alibaba.qwen.code.managedagent.catalog.ManagedDefinitionInputProviders;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.definitions.ManagedAgentDefinitionSource.Context;
import com.alibaba.qwen.code.managedagent.contracts.extensions.AgentBootstrapBundleSource;
import com.alibaba.qwen.code.managedagent.contracts.extensions.AgentBootstrapBundleSource.BundleRef;
import com.alibaba.qwen.code.managedagent.contracts.extensions.AgentBootstrapBundleSource.Download;
import com.alibaba.qwen.code.managedagent.contracts.extensions.AgentBootstrapBundleSource.Resolved;
import com.alibaba.qwen.code.managedagent.contracts.extensions.ExtensionArchiveStorage;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceAccess;
import com.sun.net.httpserver.HttpsConfigurator;
import com.sun.net.httpserver.HttpsServer;
import org.apache.commons.codec.digest.DigestUtils;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.ObjectProvider;

import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManagerFactory;

import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class ManagedAgentBootstrapPreparationTest {
    private static final String PASSWORD = "qwen-local-test";
    @TempDir
    Path temporary;
    private final AtomicInteger sourceCalls = new AtomicInteger();
    private final AtomicInteger networkCalls = new AtomicInteger();
    private HttpsServer server;
    private URI uri;
    private ManagedAgentBootstrapPreparationService service;
    private ManagedDefinitionInputProviders providers;
    private HttpClient client;
    private ExtensionArchiveStorage storage;
    private Download download;
    private RuntimeException sourceFailure;
    private byte[] bytes;

    @BeforeEach
    void setUp() throws Exception {
        bytes = "trusted bundle bytes".getBytes(StandardCharsets.UTF_8);
        var ssl = sslContext();
        server = HttpsServer.create(new InetSocketAddress("localhost", 0), 0);
        server.setHttpsConfigurator(new HttpsConfigurator(ssl));
        server.createContext("/bundle", exchange -> {
            networkCalls.incrementAndGet();
            if (exchange.getRequestURI().getPath().endsWith("redirect")) {
                exchange.sendResponseHeaders(302, -1);
                exchange.close();
                return;
            }
            if (exchange.getRequestURI().getPath().endsWith("stalled")) {
                exchange.getResponseHeaders().set("Content-Type", "application/zip");
                exchange.sendResponseHeaders(200, 0);
                exchange.getResponseBody().flush();
                try {
                    Thread.sleep(1000);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
                exchange.close();
                return;
            }
            if (exchange.getRequestURI().getPath().endsWith("slow")) {
                try {
                    Thread.sleep(1000);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
            }
            exchange.getResponseHeaders().set("Content-Type", "application/zip");
            long declared = exchange.getRequestURI().getPath().endsWith("truncated")
                    ? bytes.length + 3L : bytes.length;
            exchange.sendResponseHeaders(200,
                    exchange.getRequestURI().getPath().endsWith("chunked") ? 0 : declared);
            exchange.getResponseBody().write(bytes);
            exchange.close();
        });
        server.start();
        uri = URI.create("https://localhost:" + server.getAddress().getPort() + "/bundle?signature=private-token");
        download = new Download(uri, Instant.now().plusSeconds(30), "application/zip");
        storage = new DirectoryExtensionArchiveStorage(properties());
        var workspace = mock(ManagedWorkspaceRegistry.class);
        when(workspace.accessOf("tenant", "actor", "workspace")).thenReturn(WorkspaceAccess.OPERATOR);
        AgentBootstrapBundleSource source = new AgentBootstrapBundleSource() {
            @Override
            public String id() {
                return "catalog";
            }

            @Override
            public Resolved resolve(com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionSource.Context context,
                    BundleRef ref) {
                sourceCalls.incrementAndGet();
                if (sourceFailure != null) {
                    throw sourceFailure;
                }
                return new Resolved(ref, download);
            }
        };
        ObjectProvider<AgentBootstrapBundleSource> bundles = provider(List.of(source));
        providers = new ManagedDefinitionInputProviders("SPI",
                ManagedAgentBootstrapPreparationTest.<com.alibaba.qwen.code.managedagent.contracts.definitions.ManagedAgentDefinitionSource>provider(List.of()),
                bundles, workspace);
        client = HttpClient.newBuilder().sslContext(ssl).followRedirects(HttpClient.Redirect.NEVER)
                .connectTimeout(Duration.ofSeconds(2)).version(HttpClient.Version.HTTP_1_1).build();
        service = new ManagedAgentBootstrapPreparationService(providers, storage,
                new BootstrapDownloadSettings(Set.of("localhost"), 64 * 1024, 1,
                        Duration.ofSeconds(2), Duration.ofSeconds(3)), client);
    }

    @AfterEach
    void stopServer() {
        service.shutdown();
        if (server != null) {
            server.stop(0);
        }
    }

    @Test
    void downloadsOnlyTheMissingImmutableBundle() throws Exception {
        var bundle = bundle(bytes, "bundle-1");

        var first = service.prepare(context(), List.of(bundle)).getFirst();
        var second = service.prepare(context(), List.of(bundle)).getFirst();

        assertThat(first.digest()).isEqualTo(DigestUtils.sha256Hex(bytes));
        assertThat(first.reused()).isFalse();
        assertThat(second.reused()).isTrue();
        assertThat(sourceCalls).hasValue(2);
        assertThat(networkCalls).hasValue(1);
        var key = new ExtensionArchiveStorage.Key("tenant", "workspace", first.digest());
        try (var saved = storage.open(key)) {
            assertThat(saved.readAllBytes()).isEqualTo(bytes);
        }
        assertThat(second.toString()).doesNotContain("private-token");
    }

    @Test
    void expiredUrlDoesNotInvalidateTheSavedArtifact() {
        assertThat(service.prepare(context(), List.of(bundle(bytes, "bundle-1"))).getFirst().reused()).isFalse();
        download = new Download(uri, Instant.now().minusSeconds(1), "application/zip");

        var replay = service.prepare(context(), List.of(bundle(bytes, "bundle-1"))).getFirst();

        assertThat(replay.reused()).isTrue();
        assertThat(sourceCalls).hasValue(2);
        assertThat(networkCalls).hasValue(1);
    }

    @Test
    void sourceAuthorizationIsNotBypassedByCachedBytes() {
        var bundle = bundle(bytes, "authorization");
        assertThat(service.prepare(context(), List.of(bundle))).hasSize(1);
        sourceFailure = new ManagedAgentException(403, "source_forbidden", "Source access was revoked.");

        assertThatThrownBy(() -> service.prepare(context(), List.of(bundle)))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getStatus()).isEqualTo(403));
        assertThat(networkCalls).hasValue(1);
    }

    @Test
    void concurrentMissingDownloadsConvergeOnOneImmutableArtifact() throws Exception {
        var gated = org.mockito.Mockito.spy(storage);
        var barrier = new CyclicBarrier(2);
        org.mockito.Mockito.doAnswer(invocation -> {
            barrier.await(10, TimeUnit.SECONDS);
            return invocation.callRealMethod();
        }).when(gated).stat(org.mockito.ArgumentMatchers.any(ExtensionArchiveStorage.Key.class));
        var racing = new ManagedAgentBootstrapPreparationService(providers, gated,
                new BootstrapDownloadSettings(Set.of("localhost"), 64 * 1024, 2,
                        Duration.ofSeconds(2), Duration.ofSeconds(3)), client);
        var bundle = bundle(bytes, "concurrent");

        try (var executor = Executors.newFixedThreadPool(2)) {
            var first = executor.submit(() -> racing.prepare(context(), List.of(bundle)));
            var second = executor.submit(() -> racing.prepare(context(), List.of(bundle)));
            var left = first.get(30, TimeUnit.SECONDS);
            var right = second.get(30, TimeUnit.SECONDS);
            assertThat(left).hasSize(1);
            assertThat(right).hasSize(1);
            assertThat(left.getFirst().digest()).isEqualTo(right.getFirst().digest());
            assertThat(left.getFirst().byteLength()).isEqualTo(right.getFirst().byteLength());
            assertThat(left.getFirst().source()).isEqualTo(right.getFirst().source());
        } finally {
            racing.shutdown();
        }
        assertThat(networkCalls.get()).isBetween(1, 2);
        try (var saved = storage.open(new ExtensionArchiveStorage.Key("tenant", "workspace",
                bundle.expectedDigest()))) {
            assertThat(saved.readAllBytes()).isEqualTo(bytes);
        }
    }

    @Test
    void rejectsChangedDigestWithoutPublishingTheBundle() throws Exception {
        var bundle = new BundleRef("catalog", "changed", "release-1", "b".repeat(64), null);

        assertFailure(bundle, "bootstrap_bundle_changed");
        assertThat(storage.stat(new ExtensionArchiveStorage.Key("tenant", "workspace",
                DigestUtils.sha256Hex(bytes)))).isEmpty();
    }

    @Test
    void rejectsOversizedBodyBeforePublishing() throws Exception {
        bytes = new byte[65 * 1024];
        var bundle = bundle(bytes, "large");

        assertFailure(bundle, "bootstrap_bundle_too_large");
        assertThat(storage.stat(new ExtensionArchiveStorage.Key("tenant", "workspace",
                DigestUtils.sha256Hex(bytes)))).isEmpty();
    }

    @Test
    void configuredHostsAllowDuplicatesAndBlankTokens() {
        var configured = new ManagedAgentBootstrapPreparationService(providers, storage,
                " LOCALHOST,localhost,,LOCALHOST,", 64 * 1024, 1, "2s", "3s");
        try {
            assertThat(configured).isNotNull();
            assertThat(networkCalls).hasValue(0);
        } finally {
            configured.shutdown();
        }
    }

    @Test
    void rejectsUnapprovedDestinationsBeforeOpeningAConnection() {
        for (URI target : List.of(
                URI.create("http://localhost:" + server.getAddress().getPort() + "/bundle"),
                URI.create("https://user:secret@localhost:" + server.getAddress().getPort() + "/bundle"),
                URI.create("https://example.invalid/bundle"))) {
            download = new Download(target, Instant.now().plusSeconds(30), "application/zip");
            assertFailure(bundle(bytes, "forbidden"), "bootstrap_download_forbidden");
        }

        assertThat(networkCalls).hasValue(0);
    }

    @Test
    void rejectsAnUnknownPinnedLengthWhenTheAdvertisedBodyIsOversized() throws Exception {
        bytes = new byte[65 * 1024];
        var bundle = new BundleRef("catalog", "large-header", "release-1", DigestUtils.sha256Hex(bytes), null);

        assertFailure(bundle, "bootstrap_bundle_too_large");

        assertThat(networkCalls).hasValue(1);
        assertThat(storage.stat(new ExtensionArchiveStorage.Key("tenant", "workspace",
                bundle.expectedDigest()))).isEmpty();
    }

    @Test
    void rejectsAnUnknownPinnedLengthWhenTheStreamedBodyIsOversized() throws Exception {
        bytes = new byte[65 * 1024];
        download = new Download(URI.create(uri.toString().replace("/bundle", "/bundle/chunked")),
                Instant.now().plusSeconds(30), "application/zip");
        var bundle = new BundleRef("catalog", "large-chunked", "release-1", DigestUtils.sha256Hex(bytes), null);

        assertFailure(bundle, "bootstrap_bundle_too_large");

        assertThat(networkCalls).hasValue(1);
        assertThat(storage.stat(new ExtensionArchiveStorage.Key("tenant", "workspace",
                bundle.expectedDigest()))).isEmpty();
    }

    @Test
    void rejectsHttpsRedirectBeforeOpeningAnotherTarget() {
        download = new Download(URI.create(uri.toString().replace("/bundle", "/bundle/redirect")),
                Instant.now().plusSeconds(30), "application/zip");

        assertFailure(bundle(bytes, "redirect"), "bootstrap_archive_unavailable");
        assertThat(networkCalls).hasValue(1);
    }

    @Test
    void rejectsExpiredUriBeforeOpeningTheEndpoint() {
        download = new Download(uri, Instant.now().minusSeconds(1), "application/zip");

        assertFailure(bundle(bytes, "expired"), "bootstrap_download_deadline_exceeded");
        assertThat(networkCalls).hasValue(0);
    }

    @Test
    void rejectsATruncatedDownloadWithoutPublishing() throws Exception {
        download = new Download(URI.create(uri.toString().replace("/bundle", "/bundle/truncated")),
                Instant.now().plusSeconds(30), "application/zip");
        var bundle = bundle(bytes, "truncated");

        assertFailure(bundle, "bootstrap_archive_unavailable");
        assertThat(storage.stat(new ExtensionArchiveStorage.Key("tenant", "workspace",
                bundle.expectedDigest()))).isEmpty();
    }

    @Test
    void timesOutBeforeResponseHeaders() throws Exception {
        download = new Download(URI.create(uri.toString().replace("/bundle", "/bundle/slow")),
                Instant.now().plusSeconds(30), "application/zip");
        var bundle = bundle(bytes, "slow");
        var context = new Context("tenant", "actor", "workspace", "workspace", "timeout",
                Instant.now().plusMillis(250));

        assertThatThrownBy(() -> service.prepare(context, List.of(bundle)))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getCode()).isEqualTo("bootstrap_download_deadline_exceeded"));
        assertThat(storage.stat(new ExtensionArchiveStorage.Key("tenant", "workspace",
                bundle.expectedDigest()))).isEmpty();
    }

    @Test
    void timesOutWhileReadingTheBodyAndStopsItsWorkerOnShutdown() throws Exception {
        download = new Download(URI.create(uri.toString().replace("/bundle", "/bundle/stalled")),
                Instant.now().plusSeconds(30), "application/zip");
        var bundle = bundle(bytes, "body-stall");
        var context = new Context("tenant", "actor", "workspace", "workspace", "body-timeout",
                Instant.now().plusMillis(250));

        assertThatThrownBy(() -> service.prepare(context, List.of(bundle)))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getCode()).isEqualTo("bootstrap_download_deadline_exceeded"));
        assertThat(storage.stat(new ExtensionArchiveStorage.Key("tenant", "workspace",
                bundle.expectedDigest()))).isEmpty();
        service.shutdown();

        assertThat(ManagedAgentBootstrapPreparationService.class.getDeclaredMethod("shutdown")
                .getAnnotation(jakarta.annotation.PreDestroy.class)).isNotNull();
        assertThat(deadlineWorkers()).noneMatch(Thread::isAlive);
    }

    private static java.util.Set<Thread> deadlineWorkers() throws InterruptedException {
        var deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        java.util.Set<Thread> threads;
        do {
            threads = Thread.getAllStackTraces().keySet().stream()
                    .filter(thread -> thread.getName().equals("managed-bootstrap-download-deadline"))
                    .filter(Thread::isAlive).collect(java.util.stream.Collectors.toSet());
            if (threads.isEmpty()) {
                return threads;
            }
            Thread.sleep(10);
        } while (System.nanoTime() < deadline);
        return threads;
    }

    private void assertFailure(BundleRef bundle, String code) {
        assertThatThrownBy(() -> service.prepare(context(), List.of(bundle)))
                .isInstanceOfSatisfying(ManagedAgentException.class, error -> {
                    assertThat(error.getCode()).isEqualTo(code);
                    assertThat(error).hasMessageNotContaining("private-token");
                    assertThat(error).hasMessageNotContaining("signature=");
                });
    }

    private static BundleRef bundle(byte[] content, String resource) {
        return new BundleRef("catalog", resource, "release-1", DigestUtils.sha256Hex(content),
                (long) content.length);
    }

    private static Context context() {
        return new Context("tenant", "actor", "workspace", "workspace", "prepare", Instant.now().plusSeconds(30));
    }

    private ManagedAgentProperties properties() {
        var properties = new ManagedAgentProperties();
        properties.getExtensions().setArtifactDirectory(temporary.resolve("archives").toString());
        return properties;
    }

    private SSLContext sslContext() throws Exception {
        Path certificate = temporary.resolve("localhost.p12");
        var process = new ProcessBuilder(Path.of(System.getProperty("java.home"), "bin", "keytool").toString(),
                "-genkeypair", "-alias", "localhost", "-keyalg", "RSA", "-validity", "1",
                "-dname", "CN=localhost", "-ext", "SAN=dns:localhost,ip:127.0.0.1", "-storetype", "PKCS12",
                "-keystore", certificate.toString(), "-storepass", PASSWORD).redirectErrorStream(true).start();
        assertThat(process.waitFor(30, TimeUnit.SECONDS)).isTrue();
        assertThat(process.exitValue()).isZero();
        var store = KeyStore.getInstance("PKCS12");
        try (var input = Files.newInputStream(certificate)) {
            store.load(input, PASSWORD.toCharArray());
        }
        var keys = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
        keys.init(store, PASSWORD.toCharArray());
        var trust = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        trust.init(store);
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(keys.getKeyManagers(), trust.getTrustManagers(), null);
        return context;
    }

    @SuppressWarnings("unchecked")
    private static <T> ObjectProvider<T> provider(List<T> providers) {
        ObjectProvider<T> provider = mock(ObjectProvider.class);
        when(provider.orderedStream()).thenReturn(providers.stream());
        return provider;
    }
}
