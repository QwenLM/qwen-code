package com.alibaba.qwen.code.managedagent.extensions;

import com.alibaba.qwen.code.managedagent.config.ManagedMcpOAuthProperties.OAuthProvider;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;

import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;

class ManagedMcpOAuthClientTest {
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
