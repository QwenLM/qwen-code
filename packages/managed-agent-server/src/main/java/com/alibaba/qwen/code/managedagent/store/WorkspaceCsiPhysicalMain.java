package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.service.WorkspaceCsiResourceGuard;
import com.alibaba.qwen.code.runtimebroker.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.CsiNodeSourceClient;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.KubernetesHttpRuntimeClient;
import com.fasterxml.jackson.core.StreamReadFeature;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.json.JsonMapper;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Set;

/** Private original-retirement progress commands; public selection and physical release stay closed. */
public final class WorkspaceCsiPhysicalMain {
    private WorkspaceCsiPhysicalMain() {
    }

    static void run(String[] args) throws Exception {
        if (args.length != 5 || !"physical".equals(args[0])
                || !Set.of("status", "plan", "intent", "delete", "observe").contains(args[1])) {
            throw new IllegalArgumentException("Usage: physical <status|plan|intent|delete|observe> <reviewed-runtime-json> <reviewed-node-json> <retirement>");
        }
        var json = JsonMapper.builder().enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
                .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();
        var request = WorkspaceCsiRuntimeMain.readRequest(Path.of(args[2]), json);
        byte[] bytes;
        try (var input = Files.newInputStream(Path.of(args[3]))) {
            bytes = input.readNBytes(16 * 1024 + 1);
        }
        if (bytes.length == 0 || bytes.length > 16 * 1024) {
            throw new IllegalArgumentException("A bounded reviewed node source is required");
        }
        var nodeRequest = json.readValue(bytes, WorkspaceCsiRuntimeMain.NodeRequest.class);
        if (nodeRequest == null || nodeRequest.node() == null || !java.util.UUID.fromString(args[4]).toString().equals(args[4])) {
            throw new IllegalArgumentException("The reviewed original node and retirement are required");
        }
        var source = new DriverManagerDataSource(required("K2_JDBC_URL"), required("K2_JDBC_USER"), required("K2_JDBC_PASSWORD"));
        var jdbc = new ManagedSchemaJdbcTemplate(source);
        var manager = new DataSourceTransactionManager(source);
        var bindings = new JdbcRuntimeBindingRepository(source, AesGcmSecretProtector.fromBase64(
                required("QWEN_MANAGED_AGENT_RUNTIME_CREDENTIAL_KEY_ID"), required("QWEN_MANAGED_AGENT_RUNTIME_CREDENTIAL_KEY")));
        var ids = jdbc.queryForList("SELECT target_id FROM ma_operation WHERE operation_key = ?"
                    + " AND operation_kind = 'CSI_RETIREMENT' AND tenant_id = ? AND operation_id = ?", String.class,
                    WorkspaceOperations.key(WorkspaceOperations.Kind.CSI_RETIREMENT, request.registration().tenantId(), args[4]),
                    request.registration().tenantId(), args[4]);
        if (ids.size() != 1) {
            throw new IllegalArgumentException("The original CSI retirement is unavailable");
        }
        var binding = bindings.findById(ids.getFirst());
        WorkspaceCsiRuntimeMain.requireSelected(request, binding);
        var properties = new ManagedAgentProperties();
        properties.getSessionStore().setBindingKey(required("QWEN_MANAGED_AGENT_SESSION_STORE_BINDING_KEY"));
        var credentials = new WriterCredentialPolicy(properties);
        var nativeStore = new ManagedSessionStore(jdbc);
        nativeStore.setCredentials(credentials);
        nativeStore.setCsiBindings(bindings);
        var application = new WorkspaceCsiApplicationStore(jdbc, manager, nativeStore, bindings, new JdbcRuntimeSessionRepository(source));
        var store = new WorkspaceCsiPhysicalStore(jdbc, manager, application);
        var original = new WorkspaceCsiPhysicalStore.Original(request.registration().tenantId(), request.sessionId(),
                binding.getRequest().getScope().getWorkspaceId(), args[4]);
        String token = credentials.issue(original.tenantId(), original.workspaceId(), original.sessionId());
        if ("status".equals(args[1])) {
            System.out.println(json.writeValueAsString(store.status(original, token)));
            return;
        }
        var node = nodeRequest.node();
        if ("plan".equals(args[1])) {
            var work = store.plan(original, token, node);
            System.out.println(json.writeValueAsString(work.status()));
            return;
        }
        try (var api = new KubernetesHttpRuntimeClient(URI.create(required("K2_KUBERNETES_API_URL")),
                Path.of(required("K2_KUBERNETES_TOKEN_FILE")), Path.of(required("K2_KUBERNETES_CA_FILE")));
                var client = new CsiNodeSourceClient(node.sourceOrigin(), node.sourcePrincipal(), nodeRequest.coordinatorPrincipal(),
                        nodeRequest.clientStore(), nodeRequest.passwordFile(), nodeRequest.caFile())) {
            var guard = new WorkspaceCsiResourceGuard(api, required("K2_CLUSTER_DOMAIN"), request.registration(), request.protection());
            var coordinator = new WorkspaceCsiPhysicalCoordinator(store, node, client, api, guard);
            var result = switch (args[1]) {
                case "intent" -> coordinator.intent(original, token);
                case "delete" -> coordinator.delete(original, token);
                case "observe" -> coordinator.observe(original, token);
                default -> throw new IllegalArgumentException("Unsupported physical operation");
            };
            System.out.println(json.writeValueAsString(result));
        }
    }

    private static String required(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException("Required private CSI configuration is unavailable: " + name);
        }
        return value;
    }
}
