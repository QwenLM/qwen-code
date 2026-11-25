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
            if (exchange.getRequestURI().getPath().endsWith("slow")) {
                try {
                    Thread.sleep(1000);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
            }
            exchange.getResponseHeaders().set("Content-Type", "application/zip");
            exchange.sendResponseHeaders(200, exchange.getRequestURI().getPath().endsWith("truncated")
                    ? bytes.length + 3L : bytes.length);
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
        var providers = new ManagedDefinitionInputProviders("SPI",
                ManagedAgentBootstrapPreparationTest.<com.alibaba.qwen.code.managedagent.contracts.definitions.ManagedAgentDefinitionSource>provider(List.of()),
                bundles, workspace);
        var client = HttpClient.newBuilder().sslContext(ssl).followRedirects(HttpClient.Redirect.NEVER)
                .connectTimeout(Duration.ofSeconds(2)).version(HttpClient.Version.HTTP_1_1).build();
        service = new ManagedAgentBootstrapPreparationService(providers, storage,
                new BootstrapDownloadSettings(Set.of("localhost"), 64 * 1024, 1,
                        Duration.ofSeconds(2), Duration.ofSeconds(3)), client);
    }

    @AfterEach
    void stopServer() {
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
