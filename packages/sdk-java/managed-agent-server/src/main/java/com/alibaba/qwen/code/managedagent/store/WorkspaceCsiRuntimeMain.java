package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.service.WorkspaceCsiResourceGuard;
import com.alibaba.qwen.code.managedagent.service.WorkspaceCsiRuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.HttpRuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.ManagedCsiFilesProtocol;
import com.alibaba.qwen.code.runtimebroker.KubernetesHttpRuntimeClient;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerHttpServer;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerService;
import com.fasterxml.jackson.core.StreamReadFeature;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

/** Explicit one-Session CSI operator; ordinary Spring and Hosted selectors remain closed. */
public final class WorkspaceCsiRuntimeMain {
    private WorkspaceCsiRuntimeMain() {
    }

    public record Request(WorkspaceCsiRegistration registration, String sessionId, String runtimeRequestKey,
            String image, List<String> command, List<WorkspaceCsiRuntimeProvisioner.WorkerArtifact> artifacts,
            WorkspaceCsiResourceGuard.ProtectionIdentity protection) {
        public Request {
            if (registration == null || protection == null || sessionId == null
                    || !UUID.fromString(sessionId).toString().equals(sessionId)
                    || runtimeRequestKey == null || !runtimeRequestKey.matches("[0-9a-f]{64}")
                    || image == null || !image.matches("[^\\s]+@sha256:[0-9a-f]{64}")
                    || command == null || command.isEmpty() || command.size() > 32
                    || command.stream().anyMatch(value -> value == null || value.isBlank()
                            || value.length() > 8192 || value.indexOf('\0') >= 0)
                    || artifacts == null || artifacts.size() > 48
                    || artifacts.stream().anyMatch(java.util.Objects::isNull)
                    || artifacts.stream().map(WorkspaceCsiRuntimeProvisioner.WorkerArtifact::configMapName)
                            .distinct().count() != artifacts.size()) {
                throw new IllegalArgumentException("Invalid private CSI operator request");
            }
            command = List.copyOf(command);
            artifacts = List.copyOf(artifacts);
        }
    }

    public static void main(String[] args) {
        try {
            run(args);
        } catch (Exception failure) {
            System.err.println("Private original CSI Runtime operator could not be started.");
            System.exit(1);
        }
    }

    static void run(String[] args) throws Exception {
        if (args.length == 3 && "text".equals(args[0])) {
            WorkspaceCsiHostedMain.run(args);
            return;
        }
        if (args.length != 3 || !"serve".equals(args[0])) {
            throw new IllegalArgumentException("Usage: serve <reviewed-runtime-json> <port>");
        }
        int port = Integer.parseInt(args[2]);
        if (port < 1024 || port > 65535) {
            throw new IllegalArgumentException("A fixed unprivileged port is required");
        }
        var json = JsonMapper.builder().enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
                .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();
        var request = readRequest(Path.of(args[1]), json);
        String token = required("K2_RUNTIME_BROKER_TOKEN");
        String authorityOrigin = required("K2_RUNTIME_BROKER_ORIGIN");
        ManagedCsiFilesProtocol.authority(authorityOrigin);
        var source = new DriverManagerDataSource(required("K2_JDBC_URL"), required("K2_JDBC_USER"),
                required("K2_JDBC_PASSWORD"));
        var jdbc = new JdbcTemplate(source);
        var manager = new DataSourceTransactionManager(source);
        var properties = new ManagedAgentProperties();
        properties.setAgentRevision(required("K2_AGENT_REVISION"));
        var bindings = new JdbcRuntimeBindingRepository(source, AesGcmSecretProtector.fromBase64(
                required("QWEN_MANAGED_AGENT_RUNTIME_CREDENTIAL_KEY_ID"),
                required("QWEN_MANAGED_AGENT_RUNTIME_CREDENTIAL_KEY")));
        var sessions = new JdbcRuntimeSessionRepository(source);
        var http = new HttpRuntimeTransport();
        var access = new WorkspaceCsiRuntimeAccess(jdbc, manager, json, properties, request.registration(),
                request.sessionId(), request.runtimeRequestKey(), bindings, sessions, http);
        access.resolve(request.sessionId()).toCompletableFuture().join();
        var api = new KubernetesHttpRuntimeClient(URI.create(required("K2_KUBERNETES_API_URL")),
                Path.of(required("K2_KUBERNETES_TOKEN_FILE")), Path.of(required("K2_KUBERNETES_CA_FILE")));
        var guard = new WorkspaceCsiResourceGuard(api, required("K2_CLUSTER_DOMAIN"), request.registration(),
                request.protection());
        var provider = new WorkspaceCsiRuntimeProvisioner(new WorkspaceCsiReservationStore(jdbc, manager, json),
                bindings, request.registration(), api, guard, request.image(), request.command(),
                Duration.ofSeconds(30), request.artifacts(), authorityOrigin);
        try (var service = new RuntimeBrokerService(access, provider, access, bindings, sessions,
                new JdbcToolExecutionRepository(source), UUID.randomUUID().toString(),
                Duration.ofSeconds(30), Duration.ofSeconds(30));
                var server = new RuntimeBrokerHttpServer(new InetSocketAddress(InetAddress.getLoopbackAddress(), port),
                        token, service)) {
            requireAuthorityOrigin(authorityOrigin, server.getBaseUri());
            var stopped = new CountDownLatch(1);
            var shutdown = new Thread(() -> {
                server.close();
                stopped.countDown();
            }, "csi-runtime-shutdown");
            Runtime.getRuntime().addShutdownHook(shutdown);
            server.start();
            System.out.println(json.writeValueAsString(Map.of("sessionId", request.sessionId(),
                    "runtimeRequestKey", request.runtimeRequestKey(), "baseUri", server.getBaseUri().toString())));
            stopped.await();
        }
    }

    static void requireAuthorityOrigin(String origin, URI ownedServer) {
        ManagedCsiFilesProtocol.authority(origin);
        String host = ownedServer.getHost();
        if ("[0:0:0:0:0:0:0:1]".equals(host)) {
            host = "[::1]";
        }
        if (origin.startsWith("http:") && !origin.equals(ownedServer.getScheme() + "://" + host + ":" + ownedServer.getPort())) {
            throw new IllegalArgumentException("Loopback CSI authority must name the owned Broker listener");
        }
    }

    static Request readRequest(Path path, ObjectMapper json) {
        try (var input = Files.newInputStream(path)) {
            byte[] bytes = input.readNBytes(64 * 1024 + 1);
            if (bytes.length > 64 * 1024) {
                throw new IllegalArgumentException("CSI operator request exceeds its size limit");
            }
            Request request = json.readValue(bytes, Request.class);
            if (request == null) {
                throw new IllegalArgumentException("CSI operator request is required");
            }
            return request;
        } catch (Exception failure) {
            throw new IllegalArgumentException("CSI operator request could not be read");
        }
    }

    static String required(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            throw new IllegalStateException("Required private CSI operator setting is unavailable");
        }
        return value;
    }
}
