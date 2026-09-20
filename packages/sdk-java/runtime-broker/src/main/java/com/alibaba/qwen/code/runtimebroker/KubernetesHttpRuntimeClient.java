package com.alibaba.qwen.code.runtimebroker;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManagerFactory;

/** HTTP implementation of the Kubernetes core-v1 Runtime boundary. */
public final class KubernetesHttpRuntimeClient
        implements KubernetesRuntimeClient {
    private static final int MAXIMUM_RESPONSE_BYTES = 1024 * 1024;
    private static final Duration REQUEST_TIMEOUT = Duration.ofSeconds(30);
    private final URI apiServer;
    private final String authorization;
    private final HttpClient client;

    public KubernetesHttpRuntimeClient(URI apiServer, String bearerToken) {
        this(apiServer, bearerToken, HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_1_1)
                .followRedirects(HttpClient.Redirect.NEVER).build());
    }

    public KubernetesHttpRuntimeClient(URI apiServer, String bearerToken,
            HttpClient client) {
        this.apiServer = BrokerValues.requireOrigin(apiServer, "apiServer");
        this.authorization = "Bearer " + BrokerValues.requireId(
                bearerToken, "bearerToken");
        if (client == null) {
            throw new IllegalArgumentException("client is required");
        }
        this.client = client;
    }

    public static KubernetesHttpRuntimeClient fromServiceAccount(
            URI apiServer, Path tokenFile, Path caFile) {
        URI origin = BrokerValues.requireOrigin(apiServer, "apiServer");
        if (!"https".equalsIgnoreCase(origin.getScheme())) {
            throw new IllegalArgumentException(
                    "Kubernetes service-account API server must use HTTPS");
        }
        try {
            String token = Files.readString(tokenFile,
                    StandardCharsets.UTF_8).trim();
            HttpClient client = HttpClient.newBuilder()
                    .version(HttpClient.Version.HTTP_1_1)
                    .followRedirects(HttpClient.Redirect.NEVER)
                    .sslContext(sslContext(caFile)).build();
            return new KubernetesHttpRuntimeClient(origin, token, client);
        } catch (IOException | GeneralSecurityException exception) {
            throw new IllegalStateException(
                    "Kubernetes service account is unavailable", exception);
        }
    }

    @Override
    public CompletionStage<Map<String, Object>> getSecret(String namespace,
            String name) {
        return get(namespace, "secrets", name);
    }

    @Override
    public CompletionStage<Map<String, Object>> createSecret(
            String namespace, String name, Map<String, Object> body) {
        return create(namespace, "secrets", name, body);
    }

    @Override
    public CompletionStage<Map<String, Object>> getPod(String namespace,
            String name) {
        return get(namespace, "pods", name);
    }

    @Override
    public CompletionStage<Map<String, Object>> createPod(String namespace,
            String name, Map<String, Object> body) {
        return create(namespace, "pods", name, body);
    }

    @Override
    public CompletionStage<Void> deleteSecret(String namespace, String name,
            String uid, String resourceVersion) {
        return delete(namespace, "secrets", name, uid, resourceVersion);
    }

    @Override
    public CompletionStage<Void> deletePod(String namespace, String name,
            String uid, String resourceVersion) {
        return delete(namespace, "pods", name, uid, resourceVersion);
    }

    private CompletionStage<Map<String, Object>> get(String namespace,
            String resource, String name) {
        String itemPath = path(namespace, resource) + "/"
                + dnsLabel(name, "name");
        return send(HttpRequest.newBuilder(resolve(itemPath)).GET().build())
                .thenApply(response -> {
                    if (response.statusCode == 404) {
                        return null;
                    }
                    requireSuccess(response, "get");
                    return parse(response.body);
                });
    }

    private CompletionStage<Map<String, Object>> create(String namespace,
            String resource, String name, Map<String, Object> body) {
        byte[] encoded = JsonCodec.encode(body);
        HttpRequest request = HttpRequest.newBuilder(
                resolve(path(namespace, resource)))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofByteArray(encoded))
                .build();
        return send(request).thenCompose(response -> {
            if (response.statusCode == 409) {
                return get(namespace, resource, name);
            }
            requireSuccess(response, "create");
            return CompletableFuture.completedFuture(parse(response.body));
        });
    }

    private CompletionStage<Void> delete(String namespace, String resource,
            String name, String uid, String resourceVersion) {
        Map<String, Object> preconditions = new LinkedHashMap<>();
        preconditions.put("uid", BrokerValues.requireId(uid, "uid"));
        if (resourceVersion != null && !resourceVersion.isBlank()) {
            preconditions.put("resourceVersion", resourceVersion);
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("apiVersion", "v1");
        body.put("kind", "DeleteOptions");
        body.put("preconditions", preconditions);
        String itemPath = path(namespace, resource) + "/"
                + dnsLabel(name, "name");
        HttpRequest request = HttpRequest.newBuilder(resolve(itemPath))
                .header("Content-Type", "application/json")
                .method("DELETE", HttpRequest.BodyPublishers.ofByteArray(
                        JsonCodec.encode(body)))
                .build();
        return send(request).thenApply(response -> {
            if (response.statusCode == 404) {
                return null;
            }
            if (response.statusCode == 409 || response.statusCode == 422) {
                throw new RuntimeBrokerException(409,
                        "runtime_broker_resource_conflict",
                        "Kubernetes resource identity conflicts.", false);
            }
            requireSuccess(response, "delete");
            return null;
        });
    }

    private CompletionStage<Response> send(HttpRequest unauthed) {
        HttpRequest.Builder builder = HttpRequest.newBuilder(unauthed.uri())
                .timeout(REQUEST_TIMEOUT)
                .header("Authorization", authorization)
                .header("Accept", "application/json")
                .method(unauthed.method(), unauthed.bodyPublisher()
                        .orElse(HttpRequest.BodyPublishers.noBody()));
        unauthed.headers().map().forEach((name, values) -> values.forEach(
                value -> builder.header(name, value)));
        CompletableFuture<Response> result = new CompletableFuture<>();
        client.sendAsync(builder.build(),
                HttpResponse.BodyHandlers.ofByteArray())
                .whenComplete((response, error) -> {
                    if (error != null) {
                        RuntimeBrokerException failure = unavailable(
                                "Kubernetes API request failed.");
                        failure.initCause(error);
                        result.completeExceptionally(failure);
                        return;
                    }
                    if (response.body().length > MAXIMUM_RESPONSE_BYTES) {
                        result.completeExceptionally(unavailable(
                                "Kubernetes API response is too large."));
                        return;
                    }
                    result.complete(new Response(response.statusCode(),
                            response.body()));
                });
        return result;
    }

    private static void requireSuccess(Response response, String operation) {
        if (response.statusCode < 200 || response.statusCode >= 300) {
            if (response.statusCode == 408 || response.statusCode == 425
                    || response.statusCode == 429
                    || response.statusCode >= 500) {
                throw unavailable("Kubernetes API " + operation
                        + " returned HTTP " + response.statusCode + ".");
            }
            throw new RuntimeBrokerException(409,
                    "runtime_broker_scheduler_rejected",
                    "Kubernetes API " + operation + " returned HTTP "
                            + response.statusCode + ".",
                    false);
        }
    }

    private static Map<String, Object> parse(byte[] body) {
        try {
            return JsonCodec.parseObject(body, "Kubernetes response");
        } catch (RuntimeException exception) {
            throw unavailable("Kubernetes API returned invalid JSON.");
        }
    }

    private URI resolve(String path) {
        return apiServer.resolve(path);
    }

    private static String path(String namespace, String resource) {
        return "/api/v1/namespaces/" + dnsLabel(namespace, "namespace")
                + "/" + resource;
    }

    private static String dnsLabel(String value, String name) {
        String label = BrokerValues.requireId(value, name);
        if (label.length() > 63
                || !label.matches("[a-z0-9](?:[-a-z0-9]*[a-z0-9])?")) {
            throw new IllegalArgumentException(
                    name + " must be a Kubernetes DNS label");
        }
        return label;
    }

    private static SSLContext sslContext(Path caFile)
            throws IOException, GeneralSecurityException {
        byte[] pem = Files.readAllBytes(caFile);
        Certificate certificate = CertificateFactory.getInstance("X.509")
                .generateCertificate(new ByteArrayInputStream(pem));
        KeyStore keyStore = KeyStore.getInstance(KeyStore.getDefaultType());
        keyStore.load(null, null);
        keyStore.setCertificateEntry("kubernetes-ca", certificate);
        TrustManagerFactory trust = TrustManagerFactory.getInstance(
                TrustManagerFactory.getDefaultAlgorithm());
        trust.init(keyStore);
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(null, trust.getTrustManagers(), null);
        return context;
    }

    private static RuntimeBrokerException unavailable(String message) {
        return new RuntimeBrokerException(503,
                "runtime_broker_scheduler_unavailable", message, true);
    }

    private static final class Response {
        private final int statusCode;
        private final byte[] body;

        Response(int statusCode, byte[] body) {
            this.statusCode = statusCode;
            this.body = body;
        }
    }
}
