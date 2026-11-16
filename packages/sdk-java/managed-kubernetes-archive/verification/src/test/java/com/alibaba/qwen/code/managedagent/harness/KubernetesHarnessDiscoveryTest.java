package com.alibaba.qwen.code.managedagent.harness;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class KubernetesHarnessDiscoveryTest {
    private final ObjectMapper json = new ObjectMapper();

    @Test
    void typedListMembersMayOmitTypeMetadata() throws Exception {
        var listed = (ObjectNode) json.readTree(slice("slice", "10.0.0.2", true));
        listed.remove(List.of("apiVersion", "kind"));
        var endpoints = KubernetesHarnessDiscovery.endpoints(settings(), List.of(listed));
        assertThat(endpoints).hasSize(1);
        assertThat(endpoints.getFirst().instanceId()).isEqualTo("pod-uid");
        assertThat(endpoints.getFirst().accepting()).isTrue();
        listed.put("kind", "Endpoints");
        assertThatThrownBy(() -> KubernetesHarnessDiscovery.endpoints(settings(), List.of(listed)))
                .hasMessageContaining("scope differs");
    }

    @Test
    void deduplicatesPodIdentityAndRetainsNonReadyOwnersForDirectRouting() throws Exception {
        var settings = settings();
        var first = json.readTree(slice("uid-a", "10.0.0.2", true));
        var duplicate = json.readTree(slice("uid-b", "10.0.0.2", true));
        var endpoints = KubernetesHarnessDiscovery.endpoints(settings, List.of(first, duplicate));
        assertThat(endpoints).hasSize(1);
        assertThat(endpoints.getFirst().instanceId()).isEqualTo("pod-uid");
        assertThat(endpoints.getFirst().baseUri()).isEqualTo(URI.create("https://10.0.0.2:8443"));
        assertThat(endpoints.getFirst().accepting()).isTrue();
        var terminating = json.readTree(slice("uid-a", "10.0.0.2", false));
        endpoints = KubernetesHarnessDiscovery.endpoints(settings, List.of(terminating));
        assertThat(endpoints).hasSize(1);
        assertThat(endpoints.getFirst().accepting()).isFalse();
        endpoints = KubernetesHarnessDiscovery.endpoints(settings, List.of(first, terminating));
        assertThat(endpoints.getFirst().accepting()).isFalse();
        var conflictingPort = json.readTree(slice("uid-b", "10.0.0.3", true).replace("8443", "9443"));
        assertThatThrownBy(() -> KubernetesHarnessDiscovery.endpoints(settings, List.of(first, conflictingPort)))
                .hasMessageContaining("Conflicting Harness port");
    }

    @Test
    void refusesForeignServiceAndMissingPodTargetRatherThanSelectingAnAddress() throws Exception {
        var foreign = json.readTree(slice("slice", "10.0.0.2", true).replace("service-uid", "foreign-uid"));
        assertThatThrownBy(() -> KubernetesHarnessDiscovery.endpoints(settings(), List.of(foreign)))
                .hasMessageContaining("owner differs");
        var targetless = json.readTree(slice("slice", "10.0.0.2", true).replace("\"Pod\"", "\"Node\""));
        assertThatThrownBy(() -> KubernetesHarnessDiscovery.endpoints(settings(), List.of(targetless)))
                .hasMessageContaining("Pod target");
        var futureVersion = json.readTree(slice("slice", "10.0.0.2", true)
                .replace("\"kind\":\"Pod\"", "\"apiVersion\":\"v2\",\"kind\":\"Pod\""));
        assertThatThrownBy(() -> KubernetesHarnessDiscovery.endpoints(settings(), List.of(futureVersion)))
                .hasMessageContaining("Pod target");
    }

    @Test
    void expiredWatchRelistsAndServiceRecreationPausesNewAssignments(@TempDir Path directory) throws Exception {
        var settings = settings();
        Path token = directory.resolve("token");
        Files.writeString(token, "first-token");
        settings.setKubernetesTokenFile(token.toString());
        var lists = new AtomicInteger();
        var serviceReads = new AtomicInteger();
        var watchStarted = new CountDownLatch(1);
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/api/v1/namespaces/test/services/harness", exchange -> {
            String uid = serviceReads.incrementAndGet() == 1 ? "service-uid" : "recreated-service";
            byte[] response = ("{\"kind\":\"Service\",\"metadata\":{\"namespace\":\"test\",\"name\":\"harness\",\"uid\":\"" + uid + "\"}}")
                    .getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, response.length);
            exchange.getResponseBody().write(response);
            exchange.close();
        });
        server.createContext("/apis/discovery.k8s.io/v1/namespaces/test/endpointslices", exchange -> {
            boolean watch = exchange.getRequestURI().getRawQuery().contains("watch=true");
            String body;
            if (watch) {
                watchStarted.countDown();
                body = "{\"kind\":\"Status\",\"code\":410}";
            } else {
                lists.incrementAndGet();
                body = "{\"kind\":\"EndpointSliceList\",\"metadata\":{\"resourceVersion\":\"10\"},\"items\":["
                        + slice("slice", "10.0.0.2", true) + "]}";
            }
            byte[] response = body.getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(watch ? 410 : 200, response.length);
            exchange.getResponseBody().write(response);
            exchange.close();
        });
        server.start();
        try (var discovery = new KubernetesHarnessDiscovery(settings, json,
                URI.create("http://127.0.0.1:" + server.getAddress().getPort()),
                HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build())) {
            assertThat(watchStarted.await(3, TimeUnit.SECONDS)).isTrue();
            long until = System.nanoTime() + Duration.ofSeconds(3).toNanos();
            while ((serviceReads.get() < 2 || discovery.snapshot().current()) && System.nanoTime() < until) {
                Thread.sleep(5);
            }
            assertThat(serviceReads.get()).isGreaterThanOrEqualTo(2);
            assertThat(lists.get()).isEqualTo(1);
            assertThat(discovery.snapshot().current()).isFalse();
            assertThat(discovery.snapshot().endpoints()).hasSize(1);
        } finally {
            server.stop(0);
        }
    }

    private static ManagedAgentProperties.HarnessPool settings() {
        var properties = new ManagedAgentProperties.HarnessPool();
        properties.setNamespace("test");
        properties.setServiceName("harness");
        properties.setServiceUid("service-uid");
        return properties;
    }

    private static String slice(String id, String address, boolean ready) {
        return """
                {"apiVersion":"discovery.k8s.io/v1","kind":"EndpointSlice","addressType":"IPv4",
                 "metadata":{"uid":"%s","resourceVersion":"10","namespace":"test",
                 "labels":{"kubernetes.io/service-name":"harness"},"ownerReferences":[
                 {"apiVersion":"v1","kind":"Service","name":"harness","uid":"service-uid","controller":true}]},
                 "ports":[{"name":"https","protocol":"TCP","port":8443}],
                 "endpoints":[{"addresses":["%s"],"conditions":{"ready":%s},
                 "targetRef":{"kind":"Pod","namespace":"test","name":"harness-a","uid":"pod-uid"}}]}
                """.formatted(id, address, ready);
    }
}
