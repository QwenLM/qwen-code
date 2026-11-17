package com.alibaba.qwen.code.managedagent.harness;

import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.alibaba.qwen.code.runtimebroker.adapter.HttpRuntimeTransport;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** A bounded namespace-scoped list/watch; uncertainty never creates placement candidates. */
public final class KubernetesHarnessDiscovery implements HarnessDiscovery {
    private static final int RESPONSE_LIMIT = 2 * 1024 * 1024;
    private final ManagedAgentSettings.HarnessPool properties;
    private final ObjectMapper json;
    private final URI origin;
    private final HttpClient client;
    private final Path tokenFile;
    private final ExecutorService watcher = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "managed-harness-discovery");
        thread.setDaemon(true);
        return thread;
    });
    private final AtomicReference<CompletableFuture<?>> request = new AtomicReference<>();
    private volatile Snapshot snapshot = new Snapshot(List.of(), false);
    private volatile boolean closed;

    public KubernetesHarnessDiscovery(ManagedAgentSettings.HarnessPool properties, ObjectMapper json) {
        this(properties, json, secureOrigin(properties.getKubernetesApiUrl()),
                HttpClient.newBuilder().sslContext(HarnessTls.kubernetesContext(Path.of(properties.getKubernetesCaFile())))
                        .connectTimeout(Duration.ofSeconds(5)).followRedirects(HttpClient.Redirect.NEVER).build());
    }

    KubernetesHarnessDiscovery(ManagedAgentSettings.HarnessPool properties, ObjectMapper json, URI origin, HttpClient client) {
        label(properties.getNamespace());
        label(properties.getServiceName());
        label(properties.getPortName());
        if (properties.getServiceUid().isBlank() || properties.getServiceUid().length() > 256
                || client.followRedirects() != HttpClient.Redirect.NEVER) {
            throw new IllegalArgumentException("Kubernetes Harness discovery requires pinned Service UID and non-redirecting TLS");
        }
        this.properties = properties;
        this.json = json;
        this.origin = origin;
        this.client = client;
        this.tokenFile = Path.of(properties.getKubernetesTokenFile());
        watcher.execute(this::watch);
    }

    private static URI secureOrigin(String value) {
        URI uri = URI.create(value);
        if (!"https".equals(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null
                || uri.getQuery() != null || uri.getFragment() != null
                || uri.getPath() != null && !uri.getPath().isEmpty() && !"/".equals(uri.getPath())) {
            throw new IllegalArgumentException("Kubernetes discovery requires an HTTPS origin");
        }
        return uri;
    }

    private static void label(String value) {
        if (value == null || !value.matches("[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")) {
            throw new IllegalArgumentException("Invalid Kubernetes discovery name");
        }
    }

    @Override
    public Snapshot snapshot() {
        return snapshot;
    }

    private void watch() {
        String version = null;
        Map<String, JsonNode> slices = new HashMap<>();
        long backoff = 500;
        while (!closed) {
            try {
                String path = "/apis/discovery.k8s.io/v1/namespaces/" + properties.getNamespace() + "/endpointslices";
                String selector = "labelSelector=" + encode("kubernetes.io/service-name=" + properties.getServiceName());
                if (version == null) {
                    JsonNode service = exchange("/api/v1/namespaces/" + properties.getNamespace()
                            + "/services/" + properties.getServiceName());
                    if (!"Service".equals(service.path("kind").asText())
                            || !properties.getServiceUid().equals(service.path("metadata").path("uid").asText())
                            || !properties.getNamespace().equals(service.path("metadata").path("namespace").asText())
                            || !properties.getServiceName().equals(service.path("metadata").path("name").asText())) {
                        throw new IOException("Kubernetes Service identity differs");
                    }
                    JsonNode listed = exchange(path + "?" + selector);
                    if (!"EndpointSliceList".equals(listed.path("kind").asText()) || !listed.path("items").isArray()
                            || listed.path("items").size() > 256 || !listed.path("metadata").path("continue").asText().isEmpty()) {
                        throw new IOException("Invalid or oversized EndpointSlice list");
                    }
                    Map<String, JsonNode> replacement = new HashMap<>();
                    for (JsonNode slice : listed.path("items")) {
                        replacement.put(identity(slice.path("metadata").path("uid")), slice);
                    }
                    version = identity(listed.path("metadata").path("resourceVersion"));
                    slices = replacement;
                    snapshot = new Snapshot(endpoints(properties, slices.values()), true);
                }
                String body = exchangeBytes(path + "?" + selector + "&watch=true&allowWatchBookmarks=true&timeoutSeconds=5&resourceVersion="
                        + encode(version));
                for (String line : body.split("\\n")) {
                    if (line.isBlank()) {
                        continue;
                    }
                    JsonNode event = json.readTree(line);
                    JsonNode object = event.path("object");
                    String type = event.path("type").asText();
                    if ("ERROR".equals(type)) {
                        throw new IOException("Kubernetes watch requires a new list");
                    }
                    String nextVersion = identity(object.path("metadata").path("resourceVersion"));
                    if ("BOOKMARK".equals(type)) {
                        version = nextVersion;
                        continue;
                    }
                    String uid = identity(object.path("metadata").path("uid"));
                    switch (type) {
                        case "ADDED", "MODIFIED" -> slices.put(uid, object);
                        case "DELETED" -> slices.remove(uid);
                        default -> throw new IOException("Unknown Kubernetes watch event");
                    }
                    if (slices.size() > 256) {
                        throw new IOException("Too many EndpointSlices");
                    }
                    version = nextVersion;
                    snapshot = new Snapshot(endpoints(properties, slices.values()), true);
                }
                backoff = 500;
            } catch (Exception unavailable) {
                if (unavailable instanceof InterruptedException) {
                    Thread.currentThread().interrupt();
                    return;
                }
                snapshot = new Snapshot(snapshot.endpoints(), false);
                version = null;
                try {
                    Thread.sleep(backoff);
                } catch (InterruptedException stopped) {
                    Thread.currentThread().interrupt();
                    return;
                }
                backoff = Math.min(10_000, backoff * 2);
            }
        }
    }

    private JsonNode exchange(String path) throws Exception {
        return json.readTree(exchangeBytes(path));
    }

    private String exchangeBytes(String path) throws Exception {
        if (Files.size(tokenFile) > 64 * 1024) {
            throw new IOException("Invalid discovery token file");
        }
        String token = Files.readString(tokenFile).strip();
        if (token.isEmpty() || token.indexOf('\n') >= 0 || token.indexOf('\r') >= 0) {
            throw new IOException("Invalid discovery token");
        }
        HttpRequest sent = HttpRequest.newBuilder(origin.resolve(path)).timeout(Duration.ofSeconds(15))
                .header("Authorization", "Bearer " + token).header("Accept", "application/json").GET().build();
        var pending = client.sendAsync(sent, ignored -> new HttpRuntimeTransport.BoundedBodySubscriber(RESPONSE_LIMIT));
        request.set(pending);
        try {
            var response = pending.get(20, TimeUnit.SECONDS);
            if (response.statusCode() != 200 || response.body().overflow()) {
                throw new IOException("Kubernetes discovery failed or exceeded its bound");
            }
            return new String(response.body().bytes(), StandardCharsets.UTF_8);
        } finally {
            request.compareAndSet(pending, null);
            pending.cancel(true);
        }
    }

    static List<Endpoint> endpoints(ManagedAgentSettings.HarnessPool properties, Iterable<JsonNode> slices) throws IOException {
        Map<String, Endpoint> result = new LinkedHashMap<>();
        for (JsonNode slice : slices) {
            JsonNode metadata = slice.path("metadata");
            if (slice.has("kind") && !"EndpointSlice".equals(slice.path("kind").asText())
                    || !properties.getNamespace().equals(metadata.path("namespace").asText())
                    || !properties.getServiceName().equals(metadata.path("labels").path("kubernetes.io/service-name").asText())) {
                throw new IOException("EndpointSlice scope differs");
            }
            boolean owned = false;
            for (JsonNode owner : metadata.path("ownerReferences")) {
                owned |= "Service".equals(owner.path("kind").asText()) && "v1".equals(owner.path("apiVersion").asText())
                        && properties.getServiceName().equals(owner.path("name").asText())
                        && properties.getServiceUid().equals(owner.path("uid").asText())
                        && owner.path("controller").asBoolean();
            }
            if (!owned) {
                throw new IOException("EndpointSlice owner differs");
            }
            int port = 0;
            for (JsonNode candidate : slice.path("ports")) {
                if (properties.getPortName().equals(candidate.path("name").asText())
                        && "TCP".equals(candidate.path("protocol").asText("TCP"))) {
                    if (port != 0 || !candidate.path("port").canConvertToInt()) {
                        throw new IOException("Ambiguous Harness port");
                    }
                    port = candidate.path("port").intValue();
                }
            }
            if (port < 1 || port > 65535) {
                throw new IOException("Harness port is absent");
            }
            for (JsonNode endpoint : slice.path("endpoints")) {
                JsonNode target = endpoint.path("targetRef");
                String targetVersion = target.path("apiVersion").asText();
                if (!"Pod".equals(target.path("kind").asText()) || !targetVersion.isEmpty() && !"v1".equals(targetVersion)
                        || !properties.getNamespace().equals(target.path("namespace").asText())
                        || target.path("name").asText().isEmpty()) {
                    throw new IOException("Harness Pod target identity is absent");
                }
                String uid = identity(target.path("uid"));
                boolean accepting = endpoint.path("conditions").path("ready").asBoolean(false)
                        && !endpoint.path("conditions").path("terminating").asBoolean(false);
                for (JsonNode address : endpoint.path("addresses")) {
                    String host = address.asText();
                    String addressType = slice.path("addressType").asText();
                    if (!("IPv4".equals(addressType) && host.matches("[0-9.]{7,15}")
                            || "IPv6".equals(addressType) && host.matches("[0-9a-fA-F:]{2,39}"))) {
                        throw new IOException("Harness endpoint address is not a literal IP");
                    }
                    URI uri = URI.create("https://" + (host.contains(":") ? "[" + host + "]" : host) + ":" + port);
                    Endpoint candidate = new Endpoint(uid, uri, accepting);
                    Endpoint previous = result.get(uid);
                    if (previous == null) {
                        result.put(uid, candidate);
                    } else {
                        if (previous.baseUri().getPort() != port) {
                            throw new IOException("Conflicting Harness port for one Pod");
                        }
                        URI preferred = candidate.baseUri().toString().compareTo(previous.baseUri().toString()) < 0
                                ? candidate.baseUri() : previous.baseUri();
                        result.put(uid, new Endpoint(uid, preferred, previous.accepting() && accepting));
                    }
                }
                if (result.size() > 256) {
                    throw new IOException("Too many Harness endpoints");
                }
            }
        }
        List<Endpoint> ordered = new ArrayList<>(result.values());
        ordered.sort(Comparator.comparing(Endpoint::instanceId));
        return List.copyOf(ordered);
    }

    private static String identity(JsonNode node) throws IOException {
        if (!node.isTextual() || node.textValue().isEmpty() || node.textValue().length() > 256) {
            throw new IOException("Kubernetes identity is missing or oversized");
        }
        return node.textValue();
    }

    private static String encode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }

    @Override
    public void close() {
        closed = true;
        var pending = request.getAndSet(null);
        if (pending != null) {
            pending.cancel(true);
        }
        watcher.shutdownNow();
    }
}
