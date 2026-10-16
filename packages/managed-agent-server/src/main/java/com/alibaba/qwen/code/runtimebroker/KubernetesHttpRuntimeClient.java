package com.alibaba.qwen.code.runtimebroker;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.security.cert.CertificateFactory;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManagerFactory;

/** Bounded core-v1 API calls with rotating service-account tokens and explicit CA trust. */
public final class KubernetesHttpRuntimeClient implements KubernetesRuntimeClient, AutoCloseable {
    public static final String CSI_SOURCE_GATE = "qwen-code.io/k2-source-ready";
    public static final String CSI_RUNTIME_CLASS = "qwen-k2-runc-v1";
    private static final int RESPONSE_LIMIT = 1024 * 1024;
    private static final int CONFIG_MAP_RESPONSE_LIMIT = RESPONSE_LIMIT + 64 * 1024;
    private final URI origin;
    private final Path tokenFile;
    private final HttpClient client;
    private final Duration timeout;

    public KubernetesHttpRuntimeClient(URI origin, Path tokenFile, Path caFile) {
        this(https(origin), tokenFile, secureClient(caFile), Duration.ofSeconds(10));
    }

    KubernetesHttpRuntimeClient(URI origin, Path tokenFile, HttpClient client, Duration timeout) {
        this.origin = BrokerValues.requireOrigin(origin, "Kubernetes API origin");
        if (tokenFile == null || client == null || client.followRedirects() != HttpClient.Redirect.NEVER
                || timeout == null || timeout.isNegative() || timeout.isZero()) {
            throw new IllegalArgumentException("Token file, non-redirecting client and positive timeout are required");
        }
        this.tokenFile = tokenFile;
        this.client = client;
        this.timeout = timeout;
    }

    @Override
    public void close() {
        client.shutdownNow();
    }

    @Override
    public CompletionStage<Map<String, Object>> get(String resource, String namespace, String name) {
        if (!Set.of("pods", "secrets", "configmaps", "persistentvolumeclaims").contains(resource)) {
            throw new IllegalArgumentException("Unsupported Kubernetes resource");
        }
        dnsLabel(namespace);
        dnsSubdomain(name);
        return exchange("/api/v1/namespaces/" + namespace + "/" + resource + "/" + name, null,
                "configmaps".equals(resource) ? CONFIG_MAP_RESPONSE_LIMIT : RESPONSE_LIMIT);
    }

    @Override
    public CompletionStage<Map<String, Object>> getCluster(String resource, String name) {
        dnsSubdomain(name);
        String prefix;
        if (Set.of("persistentvolumes", "namespaces", "nodes").contains(resource)) {
            if (resource.equals("namespaces")) {
                dnsLabel(name);
            }
            prefix = "/api/v1/";
        } else if (Set.of("validatingadmissionpolicies", "validatingadmissionpolicybindings").contains(resource)) {
            prefix = "/apis/admissionregistration.k8s.io/v1/";
        } else if (resource.equals("runtimeclasses")) {
            dnsLabel(name);
            prefix = "/apis/node.k8s.io/v1/";
        } else {
            throw new IllegalArgumentException("Unsupported Kubernetes cluster resource");
        }
        return exchange(prefix + resource + "/" + name, null);
    }

    @Override
    public CompletionStage<Map<String, Object>> create(String resource, String namespace, Map<String, Object> body) {
        if (body == null) {
            throw new IllegalArgumentException("Kubernetes object is required");
        }
        if (!Set.of("pods", "secrets").contains(resource)) {
            throw new IllegalArgumentException("Unsupported Kubernetes resource");
        }
        dnsLabel(namespace);
        return exchange("/api/v1/namespaces/" + namespace + "/" + resource, body);
    }

    @Override
    public CompletionStage<Map<String, Object>> releaseCsiSchedulingGate(String namespace, String podName,
            String podUid, String resourceVersion, Map<String, Object> originalSpec) {
        originalPod(namespace, podName, podUid, resourceVersion);
        if (originalSpec == null || originalSpec.containsKey("nodeName")
                || !List.of(Map.of("name", CSI_SOURCE_GATE)).equals(originalSpec.get("schedulingGates"))) {
            throw new IllegalArgumentException("The sole original CSI source gate is required");
        }
        var patch = List.of(Map.of("op", "test", "path", "/metadata/uid", "value", podUid),
                Map.of("op", "test", "path", "/metadata/resourceVersion", "value", resourceVersion),
                Map.of("op", "test", "path", "/spec", "value", originalSpec),
                Map.of("op", "remove", "path", "/spec/schedulingGates"));
        return exchange(podPath(namespace, podName), "PATCH", "application/json-patch+json", patch,
                Set.of(200), false, RESPONSE_LIMIT);
    }

    @Override
    public CompletionStage<CsiPodDeletion.Result> deleteCsiPod(CsiPodDeletion.Request request) {
        if (request == null) {
            throw new IllegalArgumentException("The prepared original Pod deletion is required");
        }
        return exchangeResponse(podPath(request.namespace(), request.name()), "DELETE", "application/json",
                request.bytes(), RESPONSE_LIMIT).thenApply(response -> {
                    if (response.body().overflow()) {
                        throw failure(502, false);
                    }
                    return new CsiPodDeletion.Result(request, response.statusCode(), response.body().bytes());
                });
    }

    private static void originalPod(String namespace, String name, String uid, String version) {
        dnsLabel(namespace);
        dnsSubdomain(name);
        if (uid == null || !UUID.fromString(uid).toString().equals(uid) || version == null || version.isBlank()
                || version.length() > 128 || version.indexOf('\0') >= 0) {
            throw new IllegalArgumentException("Original Pod UID and resource version are required");
        }
    }

    private static String podPath(String namespace, String name) {
        return "/api/v1/namespaces/" + namespace + "/pods/" + name;
    }

    @Override
    public CompletionStage<String> readCsiPodLog(String podName) {
        dnsSubdomain(podName);
        return exchangeBytes("/api/v1/namespaces/kube-system/pods/" + podName
                + "/log?container=csi-plugin&timestamps=true&previous=false&follow=false", null).thenApply(bytes -> {
                    if (bytes == null) {
                        throw failure(404, false);
                    }
                    try {
                        return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
                    } catch (CharacterCodingException invalid) {
                        throw failure(502, false);
                    }
                });
    }

    private CompletionStage<Map<String, Object>> exchange(String path, Map<String, Object> body) {
        return exchange(path, body, RESPONSE_LIMIT);
    }

    private CompletionStage<Map<String, Object>> exchange(String path, Map<String, Object> body, int responseLimit) {
        return exchange(path, body == null ? "GET" : "POST", "application/json", body,
                Set.of(body == null ? 200 : 201), body == null, responseLimit);
    }

    private CompletionStage<Map<String, Object>> exchange(String path, String method, String contentType,
            Object body, Set<Integer> expectedStatus, boolean allowNotFound, int responseLimit) {
        return exchangeBytes(path, method, contentType, body, expectedStatus, allowNotFound, responseLimit).thenApply(bytes -> {
            if (bytes == null) {
                return null;
            }
            try {
                return JsonCodec.parseObject(bytes, "Kubernetes response");
            } catch (RuntimeException error) {
                throw failure(502, false);
            }
        });
    }

    private CompletionStage<byte[]> exchangeBytes(String path, Map<String, Object> body) {
        return exchangeBytes(path, body, RESPONSE_LIMIT);
    }

    private CompletionStage<byte[]> exchangeBytes(String path, Map<String, Object> body, int responseLimit) {
        return exchangeBytes(path, body == null ? "GET" : "POST", "application/json", body,
                Set.of(body == null ? 200 : 201), body == null, responseLimit);
    }

    private CompletionStage<byte[]> exchangeBytes(String path, String method, String contentType,
            Object body, Set<Integer> expectedStatus, boolean allowNotFound, int responseLimit) {
        return exchangeResponse(path, method, contentType, body == null ? null : JsonCodec.encode(body), responseLimit)
                .thenApply(response -> {
                    int status = response.statusCode();
                    if (allowNotFound && status == 404) {
                        return null;
                    }
                    if (!expectedStatus.contains(status)) {
                        throw failure(status, status == 429 || status >= 500);
                    }
                    if (response.body().overflow()) {
                        throw failure(502, false);
                    }
                    return response.body().bytes();
                });
    }

    private CompletionStage<HttpResponse<HttpRuntimeTransport.BoundedBody>> exchangeResponse(String path,
            String method, String contentType, byte[] body, int responseLimit) {
        HttpRequest request;
        try {
            byte[] tokenBytes;
            try (var input = Files.newInputStream(tokenFile)) {
                tokenBytes = input.readNBytes(16 * 1024 + 1);
            }
            String token = new String(tokenBytes, StandardCharsets.US_ASCII).strip();
            if (tokenBytes.length > 16 * 1024 || !token.matches("[A-Za-z0-9._~-]+")) {
                throw new IOException("Invalid token file");
            }
            var builder = HttpRequest.newBuilder(origin.resolve(path)).timeout(timeout)
                    .header("Authorization", "Bearer " + token).header("Accept", "application/json");
            if (body != null) {
                if (body.length > RESPONSE_LIMIT) {
                    throw new IllegalArgumentException("Kubernetes object exceeds its size limit");
                }
                builder.header("Content-Type", contentType).method(method, HttpRequest.BodyPublishers.ofByteArray(body));
            }
            request = builder.build();
        } catch (IOException error) {
            return CompletableFuture.failedFuture(failure(503, true));
        }
        var exchange = client.sendAsync(request,
                ignored -> new HttpRuntimeTransport.BoundedBodySubscriber(responseLimit));
        var result = exchange.thenApply(response -> response).orTimeout(timeout.toMillis(), TimeUnit.MILLISECONDS);
        result.whenComplete((ignored, error) -> {
            if (error != null) {
                exchange.cancel(true);
            }
        });
        return result.exceptionallyCompose(error -> {
            Throwable cause = error;
            while (cause instanceof java.util.concurrent.CompletionException && cause.getCause() != null) {
                cause = cause.getCause();
            }
            return CompletableFuture.failedFuture(cause instanceof RuntimeBrokerException ? cause : failure(503, true));
        });
    }

    static void dnsLabel(String value) {
        if (value == null || !value.matches("[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")) {
            throw new IllegalArgumentException("Kubernetes name must be a DNS label");
        }
    }

    static void dnsSubdomain(String value) {
        if (value == null || value.length() > 253) {
            throw new IllegalArgumentException("Kubernetes name must be a DNS subdomain");
        }
        for (String label : value.split("\\.", -1)) {
            dnsLabel(label);
        }
    }

    private static URI https(URI origin) {
        BrokerValues.requireOrigin(origin, "Kubernetes API origin");
        if (!"https".equals(origin.getScheme())) {
            throw new IllegalArgumentException("Kubernetes API requires HTTPS");
        }
        return origin;
    }

    private static HttpClient secureClient(Path caFile) {
        try (var input = Files.newInputStream(caFile)) {
            var certificates = CertificateFactory.getInstance("X.509").generateCertificates(input);
            if (certificates.isEmpty()) {
                throw new GeneralSecurityException("Empty CA bundle");
            }
            KeyStore store = KeyStore.getInstance(KeyStore.getDefaultType());
            store.load(null, null);
            int index = 0;
            for (var certificate : certificates) {
                store.setCertificateEntry("ca-" + index++, certificate);
            }
            var trust = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
            trust.init(store);
            var ssl = SSLContext.getInstance("TLS");
            ssl.init(null, trust.getTrustManagers(), null);
            return HttpClient.newBuilder().sslContext(ssl).followRedirects(HttpClient.Redirect.NEVER)
                    .connectTimeout(Duration.ofSeconds(5)).build();
        } catch (IOException | GeneralSecurityException error) {
            throw new IllegalArgumentException("Kubernetes CA could not be loaded");
        }
    }

    private static RuntimeBrokerException failure(int status, boolean retryable) {
        return new RuntimeBrokerException(status >= 400 && status <= 599 ? status : 502,
                "runtime_kubernetes_api_failed", "Kubernetes API request failed.", retryable);
    }
}
