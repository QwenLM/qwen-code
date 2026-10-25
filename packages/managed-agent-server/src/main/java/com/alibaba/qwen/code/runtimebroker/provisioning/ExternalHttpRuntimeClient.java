package com.alibaba.qwen.code.runtimebroker.provisioning;

import com.alibaba.qwen.code.runtimebroker.JsonCodec;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.transport.HttpRuntimeTransport;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.TimeUnit;

/** Bounded JSON POST client for the external provider contract. */
public final class ExternalHttpRuntimeClient implements ExternalRuntimeClient {
    static final String PROVISION_PATH = "provision";
    static final String OBSERVE_PATH = "observe";
    private static final int REQUEST_LIMIT = 64 * 1024;
    private static final int RESPONSE_LIMIT = 64 * 1024;
    private final URI base;
    private final String token;
    private final HttpClient client;
    private final Duration timeout;

    public ExternalHttpRuntimeClient(URI base, String token, Duration timeout) {
        this(base, token, HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER)
                .connectTimeout(Duration.ofSeconds(5)).build(), timeout);
    }

    ExternalHttpRuntimeClient(URI base, String token, HttpClient client, Duration timeout) {
        if (base == null || (!"http".equals(base.getScheme()) && !"https".equals(base.getScheme()))
                || base.getHost() == null || base.getUserInfo() != null || base.getQuery() != null
                || base.getFragment() != null) {
            throw new IllegalArgumentException("External Runtime provider URL must be an HTTP(S) URL");
        }
        if (token == null || token.startsWith("replace-")
                || !token.matches("[A-Za-z0-9._~+/=-]{16,4096}")) {
            throw new IllegalArgumentException("External Runtime provider token must be at least 16 safe characters");
        }
        if (client == null || client.followRedirects() != HttpClient.Redirect.NEVER
                || timeout == null || timeout.isNegative() || timeout.isZero()) {
            throw new IllegalArgumentException("Non-redirecting client and positive timeout are required");
        }
        String path = base.getPath() == null || base.getPath().isEmpty() ? "/" : base.getPath();
        this.base = base.resolve(path.endsWith("/") ? path : path + "/");
        this.token = token;
        this.client = client;
        this.timeout = timeout;
    }

    @Override
    public CompletionStage<Map<String, Object>> provision(Map<String, Object> request) {
        return post(PROVISION_PATH, request);
    }

    @Override
    public CompletionStage<Map<String, Object>> observe(Map<String, Object> request) {
        return post(OBSERVE_PATH, request);
    }

    private CompletionStage<Map<String, Object>> post(String path, Map<String, Object> body) {
        HttpRequest request;
        try {
            byte[] bytes = JsonCodec.encode(body);
            if (bytes.length > REQUEST_LIMIT) {
                throw new IllegalArgumentException("External Runtime request exceeds its size limit");
            }
            request = HttpRequest.newBuilder(base.resolve(path)).timeout(timeout)
                    .header("Authorization", "Bearer " + token)
                    .header("Content-Type", "application/json")
                    .header("Accept", "application/json")
                    .header("Cache-Control", "no-store")
                    .POST(HttpRequest.BodyPublishers.ofByteArray(bytes)).build();
        } catch (RuntimeException error) {
            return CompletableFuture.failedFuture(failure(400, false));
        }
        var exchange = client.sendAsync(request,
                ignored -> new HttpRuntimeTransport.BoundedBodySubscriber(RESPONSE_LIMIT));
        var result = exchange.thenApply(response -> {
            int status = response.statusCode();
            if (status != 200) {
                // Only 408/429/5xx are retryable; every other non-200 (3xx, 4xx) is a permanent answer.
                throw failure(status, status == 408 || status == 429 || status >= 500);
            }
            if (response.body().overflow()) {
                throw failure(502, false);
            }
            try {
                return JsonCodec.parseObject(response.body().bytes(), "External Runtime response");
            } catch (RuntimeException error) {
                throw failure(502, false);
            }
        }).orTimeout(timeout.toMillis(), TimeUnit.MILLISECONDS);
        result.whenComplete((ignored, error) -> {
            if (error != null) {
                exchange.cancel(true);
            }
        });
        return result.exceptionallyCompose(error -> {
            Throwable cause = error;
            while (cause instanceof CompletionException && cause.getCause() != null) {
                cause = cause.getCause();
            }
            return CompletableFuture.failedFuture(cause instanceof RuntimeBrokerException ? cause : failure(503, true));
        });
    }

    private static RuntimeBrokerException failure(int status, boolean retryable) {
        return new RuntimeBrokerException(status >= 400 && status <= 599 ? status : 502,
                "runtime_external_provider_failed", "External Runtime provider request failed.", retryable);
    }
}
