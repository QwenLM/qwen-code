package com.alibaba.qwen.code.managedagent.extensions;

import com.alibaba.qwen.code.managedagent.config.ManagedMcpOAuthProperties.OAuthProvider;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.test.util.ReflectionTestUtils;

import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;

class ManagedMcpOAuthClientTest {
    @ParameterizedTest
    @ValueSource(strings = {
        "https://100.100.100.200/latest/meta-data/",
        "https://[64:ff9b::a00:1]/metadata",
        "https://[::ffff:100.100.100.200]/metadata",
        "https://198.18.0.1/metadata",
        "https://192.0.0.1/metadata",
        "https://240.0.0.1/metadata"
    })
    void refusesSpecialDestinationsBeforeCallingTheHttpTransport(String url) {
        var provider = new OAuthProvider();
        provider.setResourceMetadataUri(url);
        provider.setAllowPrivateNetwork(false);
        var client = new ManagedMcpOAuthClient(new ObjectMapper());
        var transport = mock(HttpClient.class);
        ReflectionTestUtils.setField(client, "http", transport);
        assertThatThrownBy(() -> client.verifyMetadata(provider))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getCode()).isEqualTo("oauth_authorization_unavailable"));
        verifyNoInteractions(transport);
    }

    @ParameterizedTest
    @CsvSource({
        "0.1.2.3, false", "10.1.2.3, false", "127.0.0.1, false",
        "100.63.255.255, true", "100.64.0.0, false", "100.127.255.255, false", "100.128.0.0, true",
        "169.254.1.1, false", "172.16.0.1, false", "172.31.255.255, false", "172.32.0.1, true",
        "192.0.0.1, false", "192.0.1.1, true", "192.0.2.1, false", "192.88.99.1, false", "192.168.1.1, false",
        "198.18.0.1, false", "198.19.255.255, false", "198.20.0.1, true", "198.51.100.1, false",
        "203.0.113.1, false", "224.0.0.1, false", "240.0.0.1, false", "255.255.255.255, false",
        "8.8.8.8, true", "::1, false", "fc00::1, false", "fe80::1, false", "ff02::1, false",
        "::ffff:10.0.0.1, false", "::ffff:8.8.8.8, true", "::10.0.0.1, false", "64:ff9b::a00:1, false",
        "64:ff9b:1::1, false", "2001::1, false", "2001:1ff::1, false", "2001:200::1, true",
        "2001:db8::1, false", "2002::1, false", "3fff::1, false", "2606:4700:4700::1111, true"
    })
    void usesTheRepositoryPublicNetworkAddressRanges(String value, boolean expected) throws Exception {
        assertThat(ManagedMcpOAuthClient.isPublicAddress(InetAddress.getByName(value))).isEqualTo(expected);
    }

    @Test
    void boundsAProviderThatSendsHeadersAndThenStallsTheTokenBody() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        var release = new CountDownLatch(1);
        server.createContext("/token", exchange -> {
            exchange.getRequestBody().readAllBytes();
            exchange.sendResponseHeaders(200, 1024);
            try (var output = exchange.getResponseBody()) {
                output.write('{');
                output.flush();
                try {
                    release.await(25, TimeUnit.SECONDS);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
            }
        });
        server.start();
        try {
            OAuthProvider provider = new OAuthProvider();
            provider.setTokenEndpoint("http://127.0.0.1:" + server.getAddress().getPort() + "/token");
            provider.setResourceUri("https://mcp.example/mcp");
            provider.setClientId("client");
            provider.setAllowInsecureLoopback(true);
            provider.setAllowPrivateNetwork(true);
            var client = new ManagedMcpOAuthClient(new ObjectMapper());
            assertTimeoutPreemptively(Duration.ofSeconds(20), () ->
                    assertThatThrownBy(() -> client.refresh(provider, "private-refresh"))
                            .isInstanceOf(ManagedAgentException.class));
        } finally {
            release.countDown();
            server.stop(0);
        }
    }

    @Test
    void verifiesRegisteredMetadataAndUsesResourceForRealHttpCodeAndRefreshExchanges()
            throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        String base = "http://127.0.0.1:" + server.getAddress().getPort();
        var request = new AtomicReference<String>();
        server.createContext(
                "/resource",
                exchange -> {
                    byte[] body =
                            ("{\"resource\":\""
                                            + base
                                            + "/mcp\",\"authorization_servers\":[\""
                                            + base
                                            + "\"]}")
                                    .getBytes(StandardCharsets.UTF_8);
                    exchange.sendResponseHeaders(200, body.length);
                    try (var output = exchange.getResponseBody()) {
                        output.write(body);
                    }
                });
        server.createContext(
                "/metadata",
                exchange -> {
                    byte[] body =
                            ("{\"issuer\":\""
                                            + base
                                            + "\",\"authorization_endpoint\":\""
                                            + base
                                            + "/authorize\","
                                            + "\"token_endpoint\":\""
                                            + base
                                            + "/token\",\"code_challenge_methods_supported\":[\"S256\"],\"response_types_supported\":[\"code\"]}")
                                    .getBytes(StandardCharsets.UTF_8);
                    exchange.sendResponseHeaders(200, body.length);
                    try (var output = exchange.getResponseBody()) {
                        output.write(body);
                    }
                });
        server.createContext(
                "/token",
                exchange -> {
                    request.set(
                            new String(
                                    exchange.getRequestBody().readAllBytes(),
                                    StandardCharsets.UTF_8));
                    byte[] body =
                            "{\"access_token\":\"access-current\",\"refresh_token\":\"refresh-current\",\"token_type\":\"Bearer\",\"expires_in\":3600,\"id_token\":\"unused\"}"
                                    .getBytes(StandardCharsets.UTF_8);
                    exchange.sendResponseHeaders(200, body.length);
                    try (var output = exchange.getResponseBody()) {
                        output.write(body);
                    }
                });
        server.start();
        try {
            OAuthProvider provider = new OAuthProvider();
            provider.setIssuer(base);
            provider.setResourceUri(base + "/mcp");
            provider.setResourceMetadataUri(base + "/resource");
            provider.setAuthorizationMetadataUri(base + "/metadata");
            provider.setAuthorizationEndpoint(base + "/authorize");
            provider.setTokenEndpoint(base + "/token");
            provider.setClientId("registered-client");
            provider.setScopes(List.of("read"));
            provider.setAllowInsecureLoopback(true);
            provider.setAllowPrivateNetwork(true);
            var client = new ManagedMcpOAuthClient(new ObjectMapper());
            client.verifyMetadata(provider);
            assertThat(
                            client.exchange(
                                            provider,
                                            base + "/oauth/mcp/callback",
                                            "code",
                                            "verifier")
                                    .has("id_token"))
                    .isFalse();
            assertThat(request.get())
                    .contains(
                            "grant_type=authorization_code",
                            "code_verifier=verifier",
                            "resource=http%3A%2F%2F127.0.0.1");
            client.refresh(provider, "rotating-refresh");
            assertThat(request.get())
                    .contains(
                            "grant_type=refresh_token",
                            "refresh_token=rotating-refresh",
                            "resource=");
            provider.setAllowPrivateNetwork(false);
            assertThatThrownBy(() -> client.verifyMetadata(provider))
                    .isInstanceOf(ManagedAgentException.class);
        } finally {
            server.stop(0);
        }
    }
}
