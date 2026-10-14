package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.service.WorkspaceCsiResourceGuard;
import com.alibaba.qwen.code.managedagent.service.WorkspaceCsiRuntimeProvisioner;
import com.alibaba.qwen.code.managedagent.service.WorkspaceCsiNodeEvidence;
import com.alibaba.qwen.code.runtimebroker.CsiNodeSourceClient;
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
        if (args.length > 0 && "physical".equals(args[0])) {
            WorkspaceCsiPhysicalMain.run(args);
            return;
        }
        if (args.length == 2 && "source-status".equals(args[0])) {
            WorkspaceCsiNodeSourceMain.run(args);
            return;
        }
        if (args.length == 3 && ("text".equals(args[0]) || "retire".equals(args[0]))) {
            WorkspaceCsiHostedMain.run(args);
            return;
        }
        boolean retained = args.length == 4 && "serve-retained".equals(args[0]);
        boolean evidenceMode = args.length == 4 && "serve-evidence".equals(args[0]);
        if (!retained && !evidenceMode && (args.length != 3 || !"serve".equals(args[0]))) {
            throw new IllegalArgumentException("Usage: serve <reviewed-runtime-json> <port> | serve-evidence <reviewed-runtime-json> <port> <reviewed-node-json> | serve-retained <reviewed-runtime-json> <port> <retirement>");
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
        var jdbc = new ManagedSchemaJdbcTemplate(source);
        var manager = new DataSourceTransactionManager(source);
        var properties = new ManagedAgentProperties();
        properties.setAgentRevision(required("K2_AGENT_REVISION"));
        if (retained) {
            properties.getSessionStore().setBindingKey(required("QWEN_MANAGED_AGENT_SESSION_STORE_BINDING_KEY"));
        }
        var bindings = new JdbcRuntimeBindingRepository(source, AesGcmSecretProtector.fromBase64(
                required("QWEN_MANAGED_AGENT_RUNTIME_CREDENTIAL_KEY_ID"),
                required("QWEN_MANAGED_AGENT_RUNTIME_CREDENTIAL_KEY")));
        var sessions = new JdbcRuntimeSessionRepository(source);
        var http = new HttpRuntimeTransport();
        var nativeStore = new ManagedSessionStore(jdbc);
        nativeStore.setCredentials(new WriterCredentialPolicy(properties));
        nativeStore.setCsiBindings(bindings);
        var application = new WorkspaceCsiApplicationStore(jdbc, manager, nativeStore, bindings, sessions);
        var access = new WorkspaceCsiRuntimeAccess(jdbc, manager, json, properties, request.registration(),
                request.sessionId(), request.runtimeRequestKey(), bindings, sessions, http);
        if (retained) {
            var ids = jdbc.queryForList("SELECT target_id FROM ma_operation WHERE operation_key = ?"
                    + " AND operation_kind = 'CSI_RETIREMENT' AND tenant_id = ? AND operation_id = ?", String.class,
                    WorkspaceOperations.key(WorkspaceOperations.Kind.CSI_RETIREMENT, request.registration().tenantId(), args[3]),
                    request.registration().tenantId(), args[3]);
            if (ids.size() != 1) {
                throw new IllegalArgumentException("Original retirement is unavailable");
            }
            var original = bindings.findById(ids.getFirst());
            requireSelected(request, original);
            var state = application.status(request.registration().tenantId(), request.sessionId(),
                    original.getRequest().getScope().getWorkspaceId(), args[3], new WriterCredentialPolicy(properties).issue(
                            request.registration().tenantId(), original.getRequest().getScope().getWorkspaceId(), request.sessionId()));
            if ("SETTLING".equals(state.stage())) {
                throw new IllegalArgumentException("A saved frozen retirement is required");
            }
        } else {
            access.resolve(request.sessionId()).toCompletableFuture().join();
        }
        var api = new KubernetesHttpRuntimeClient(URI.create(required("K2_KUBERNETES_API_URL")),
                Path.of(required("K2_KUBERNETES_TOKEN_FILE")), Path.of(required("K2_KUBERNETES_CA_FILE")));
        var guard = new WorkspaceCsiResourceGuard(api, required("K2_CLUSTER_DOMAIN"), request.registration(),
                request.protection());
        var storage = new WorkspaceCsiReservationStore(jdbc, manager, json);
        var evidence = evidenceMode ? nodeEvidence(Path.of(args[3]), json, jdbc, manager, bindings, request, api) : null;
        var provider = evidence == null ? new WorkspaceCsiRuntimeProvisioner(storage, bindings, request.registration(), api,
                guard, request.image(), request.command(), Duration.ofSeconds(30), request.artifacts(), authorityOrigin)
                : new WorkspaceCsiRuntimeProvisioner(storage, bindings, request.registration(), api, guard, request.image(),
                        request.command(), Duration.ofSeconds(30), request.artifacts(), authorityOrigin, evidence);
        try (var service = new RuntimeBrokerService(access, provider, access, bindings, sessions,
                new JdbcToolExecutionRepository(source, bindings), UUID.randomUUID().toString(),
                Duration.ofSeconds(30), Duration.ofSeconds(30));
                var server = new RuntimeBrokerHttpServer(new InetSocketAddress(InetAddress.getLoopbackAddress(), port),
                        token, service, false, access::readNative)) {
            requireAuthorityOrigin(authorityOrigin, server.getBaseUri());
            server.registerCsiApplicationAuthority(request.registration().tenantId(), request.sessionId(),
                    (workerToken, body) -> application.workerAuthority(request.registration().tenantId(), request.sessionId(), workerToken, body));
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

    public record NodeRequest(WorkspaceCsiNodeSourceStore.Node node, String coordinatorPrincipal,
            Path clientStore, Path passwordFile, Path caFile) { }

    private static WorkspaceCsiNodeEvidence nodeEvidence(Path path, ObjectMapper json, JdbcTemplate jdbc,
            DataSourceTransactionManager manager, JdbcRuntimeBindingRepository bindings, Request runtime,
            com.alibaba.qwen.code.runtimebroker.KubernetesRuntimeClient api) throws java.io.IOException {
        byte[] bytes;
        try (var input = Files.newInputStream(path)) {
            bytes = input.readNBytes(16 * 1024 + 1);
        }
        if (bytes.length == 0 || bytes.length > 16 * 1024) {
            throw new IllegalArgumentException("A bounded reviewed node source is required");
        }
        var request = json.readValue(bytes, NodeRequest.class);
        if (request == null || request.node() == null) {
            throw new IllegalArgumentException("A reviewed node source is required");
        }
        var source = new CsiNodeSourceClient(request.node().sourceOrigin(), request.node().sourcePrincipal(),
                request.coordinatorPrincipal(), request.clientStore(), request.passwordFile(), request.caFile());
        try {
            var gateway = new CsiNodeSourceClient(request.node().gatewayOrigin(), request.node().gatewayPrincipal(),
                    request.coordinatorPrincipal(), request.clientStore(), request.passwordFile(), request.caFile());
            try {
                return new WorkspaceCsiNodeEvidence(new WorkspaceCsiNodeSourceStore(jdbc, manager, bindings), request.node(),
                        runtime.registration(), api, source, gateway, runtime.image());
            } catch (RuntimeException failure) {
                gateway.close();
                throw failure;
            }
        } catch (RuntimeException failure) {
            source.close();
            throw failure;
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

    static void requireSelected(Request request, com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord binding) {
        if (binding == null || !request.runtimeRequestKey().equals(binding.getRequest().requestKey())
                || !request.sessionId().equals(binding.getRequest().getIsolationKey())
                || !request.registration().tenantId().equals(binding.getRequest().getScope().getTenantId())
                || !request.registration().storageId().equals(binding.getRequest().getStorageId())
                || !request.registration().mountRoot().equals(binding.getRequest().getScope().getCanonicalCwd())) {
            throw new IllegalArgumentException("Reviewed original CSI Runtime is unavailable");
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
