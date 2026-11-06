package com.alibaba.qwen.code.managedagent.extensions;

import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedMcpOAuthConfiguration.Provider;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.codec.digest.DigestUtils;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.net.InetAddress;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

@Component
public class ManagedMcpOAuthClient {
    private static final ScheduledThreadPoolExecutor RESPONSE_DEADLINES = responseDeadlines();
    private final HttpClient http;
    private final ObjectMapper json;

    public ManagedMcpOAuthClient(@Qualifier("managedAgentObjectMapper") ObjectMapper json) {
        this.json = json;
        this.http =
                HttpClient.newBuilder()
                        .followRedirects(HttpClient.Redirect.NEVER)
                        .connectTimeout(Duration.ofSeconds(10))
                        .build();
    }

    public void verifyMetadata(Provider provider) {
        JsonNode resource = get(provider, provider.getResourceMetadataUri());
        JsonNode authorization = get(provider, provider.getAuthorizationMetadataUri());
        if (!provider.getResourceUri().equals(resource.path("resource").asText())
                || !strings(resource.path("authorization_servers")).contains(provider.getIssuer())
                || !provider.getIssuer().equals(authorization.path("issuer").asText())
                || !provider.getAuthorizationEndpoint()
                        .equals(authorization.path("authorization_endpoint").asText())
                || !provider.getTokenEndpoint()
                        .equals(authorization.path("token_endpoint").asText())
                || !strings(authorization.path("code_challenge_methods_supported")).contains("S256")
                || !strings(authorization.path("response_types_supported")).contains("code")
                || authorization.has("token_endpoint_auth_methods_supported")
                        && !strings(authorization.get("token_endpoint_auth_methods_supported"))
                                .contains(
                                        provider.getClientSecret() == null
                                                        || provider.getClientSecret().isBlank()
                                                ? "none"
                                                : "client_secret_post")) {
            throw unavailable();
        }
        checked(provider, provider.getAuthorizationEndpoint());
    }

    public JsonNode exchange(Provider provider, String callback, String code, String verifier) {
        Map<String, String> form = clientForm(provider);
        form.put("grant_type", "authorization_code");
        form.put("code", code);
        form.put("code_verifier", verifier);
        form.put("redirect_uri", callback);
        return tokens(provider, form);
    }

    public JsonNode refresh(Provider provider, String refreshToken) {
        Map<String, String> form = clientForm(provider);
        form.put("grant_type", "refresh_token");
        form.put("refresh_token", refreshToken);
        return tokens(provider, form);
    }

    public void revoke(Provider provider, String token) {
        if (provider.getRevocationEndpoint() == null
                || provider.getRevocationEndpoint().isBlank()) {
            return;
        }
        Map<String, String> form = clientForm(provider);
        form.put("token", token);
        try {
            post(provider, provider.getRevocationEndpoint(), form, false);
        } catch (ManagedAgentException ignored) {
            /* Local generation revocation remains authoritative. */
        }
    }

    public String providerDigest(Provider provider) {
        return DigestUtils.sha256Hex(
                String.join(
                        "\0",
                        provider.getIssuer(),
                        provider.getResourceUri(),
                        provider.getClientId(),
                        provider.getAuthorizationEndpoint(),
                        provider.getTokenEndpoint()));
    }

    public static List<String> strings(JsonNode value) {
        if (!value.isArray() || value.size() > 128) {
            throw unavailable();
        }
        List<String> result = new ArrayList<>();
        for (JsonNode entry : value) {
            if (!entry.isTextual() || entry.asText().isBlank() || entry.asText().length() > 4096) {
                throw unavailable();
            }
            result.add(entry.asText());
        }
        return List.copyOf(result);
    }

    public static String form(Map<String, String> values) {
        return values.entrySet().stream()
                .map(entry -> encode(entry.getKey()) + "=" + encode(entry.getValue()))
                .collect(java.util.stream.Collectors.joining("&"));
    }

    private JsonNode tokens(Provider provider, Map<String, String> form) {
        JsonNode tokens = post(provider, provider.getTokenEndpoint(), form, true);
        if (!tokens.isObject()
                || !tokens.path("access_token").isTextual()
                || tokens.path("access_token").asText().isBlank()
                || tokens.path("access_token").asText().length() > 8192
                || tokens.path("access_token").asText().chars().anyMatch(Character::isISOControl)
                || !"Bearer".equalsIgnoreCase(tokens.path("token_type").asText())
                || !tokens.path("expires_in").isIntegralNumber()
                || !tokens.path("expires_in").canConvertToLong()
                || tokens.path("expires_in").asLong() < 1
                || tokens.path("expires_in").asLong() > 31_536_000
                || tokens.has("refresh_token")
                        && (!tokens.get("refresh_token").isTextual()
                                || tokens.get("refresh_token").asText().length() > 8192)) {
            throw unavailable();
        }
        var selected = json.createObjectNode();
        for (String key :
                List.of("access_token", "refresh_token", "token_type", "expires_in", "scope")) {
            if (tokens.has(key)) {
                selected.set(key, tokens.get(key));
            }
        }
        if (selected.toString().getBytes(StandardCharsets.UTF_8).length > 8 * 1024) {
            throw unavailable();
        }
        return selected;
    }

    private JsonNode get(Provider provider, String url) {
        return send(
                HttpRequest.newBuilder(checked(provider, url))
                        .timeout(Duration.ofSeconds(15))
                        .header("Accept", "application/json")
                        .GET()
                        .build(),
                true);
    }

    private JsonNode post(
            Provider provider, String url, Map<String, String> values, boolean parse) {
        return send(
                HttpRequest.newBuilder(checked(provider, url))
                        .timeout(Duration.ofSeconds(15))
                        .header("Accept", "application/json")
                        .header("Content-Type", "application/x-www-form-urlencoded")
                        .POST(HttpRequest.BodyPublishers.ofString(form(values)))
                        .build(),
                parse);
    }

    private JsonNode send(HttpRequest request, boolean parse) {
        long deadline = System.nanoTime() + Duration.ofSeconds(15).toNanos();
        try {
            var response = http.send(request, HttpResponse.BodyHandlers.ofInputStream());
            try (var body = response.body()) {
                var timeout = RESPONSE_DEADLINES.schedule(() -> {
                    try {
                        body.close();
                    } catch (IOException ignored) {
                        // The request fails closed when the timed-out body cannot be read.
                    }
                }, Math.max(0, deadline - System.nanoTime()), TimeUnit.NANOSECONDS);
                try {
                    byte[] bytes = body.readNBytes(32 * 1024 + 1);
                    if (System.nanoTime() >= deadline || response.statusCode() < 200
                            || response.statusCode() >= 300 || bytes.length > 32 * 1024) {
                        throw unavailable();
                    }
                    if (!parse) {
                        return json.createObjectNode();
                    }
                    JsonNode value = json.readTree(bytes);
                    if (value == null || !value.isObject()) {
                        throw unavailable();
                    }
                    return value;
                } finally {
                    timeout.cancel(false);
                }
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw unavailable();
        } catch (IOException | IllegalArgumentException failure) {
            throw unavailable();
        }
    }

    private static ScheduledThreadPoolExecutor responseDeadlines() {
        var executor = new ScheduledThreadPoolExecutor(1, task -> {
            Thread thread = new Thread(task, "managed-mcp-oauth-response-deadline");
            thread.setDaemon(true);
            return thread;
        });
        executor.setRemoveOnCancelPolicy(true);
        return executor;
    }

    private static URI checked(Provider provider, String url) {
        try {
            URI uri = URI.create(url);
            if (uri.getHost() == null || uri.getUserInfo() != null || uri.getFragment() != null) {
                throw unavailable();
            }
            var addresses = Arrays.asList(InetAddress.getAllByName(uri.getHost()));
            boolean loopback = addresses.stream().allMatch(InetAddress::isLoopbackAddress);
            if (!"https".equalsIgnoreCase(uri.getScheme())
                    && !("http".equalsIgnoreCase(uri.getScheme())
                            && provider.isAllowInsecureLoopback()
                            && loopback)) {
                throw unavailable();
            }
            if (!provider.isAllowPrivateNetwork()
                    && addresses.stream()
                            .anyMatch(
                                    address ->
                                            address.isAnyLocalAddress()
                                                    || address.isLoopbackAddress()
                                                    || address.isLinkLocalAddress()
                                                    || address.isSiteLocalAddress()
                                                    || address.isMulticastAddress()
                                                    || (address.getAddress().length == 16
                                                            && (address.getAddress()[0] & 0xfe)
                                                                    == 0xfc))) {
                throw unavailable();
            }
            return uri;
        } catch (IOException | IllegalArgumentException failure) {
            throw unavailable();
        }
    }

    private static Map<String, String> clientForm(Provider provider) {
        Map<String, String> form = new LinkedHashMap<>();
        form.put("client_id", provider.getClientId());
        form.put("resource", provider.getResourceUri());
        if (provider.getClientSecret() != null && !provider.getClientSecret().isBlank()) {
            form.put("client_secret", provider.getClientSecret());
        }
        return form;
    }

    private static String encode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }

    private static ManagedAgentException unavailable() {
        return new ManagedAgentException(
                409,
                "oauth_authorization_unavailable",
                "The OAuth provider could not be verified or reached.");
    }
}
