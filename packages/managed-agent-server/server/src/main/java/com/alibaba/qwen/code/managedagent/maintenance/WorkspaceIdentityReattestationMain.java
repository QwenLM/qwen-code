package com.alibaba.qwen.code.managedagent.maintenance;

import com.alibaba.qwen.code.managedagent.adapters.workspace.LocalWorktreeFiles;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.config.runtime.RuntimeProviderRegistry;
import com.alibaba.qwen.code.managedagent.persistence.JdbcWorkspaceExecutionStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceIdentityReattestationStore;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceStorageGuard;
import com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore;
import com.alibaba.qwen.code.managedagent.workspace.runtime.WorkspaceRuntimeProvisioner;
import com.alibaba.qwen.code.managedagent.workspace.runtime.WorkspaceRuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.adapter.HttpRuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.adapter.security.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.host.MacOsHostIdentity;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds;
import com.alibaba.qwen.code.runtimebroker.provisioning.NativeStorageIdentityReader;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerService;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;

/** Private offline entry; never opens a listener or admits a new Runtime. */
public final class WorkspaceIdentityReattestationMain {
    private WorkspaceIdentityReattestationMain() { }

    public static void main(String[] args) throws Exception {
        if (args.length < 2 || !Set.of("plan", "begin", "retire", "complete").contains(args[0])
                || ("plan".equals(args[0]) ? args.length != 2
                        : args.length != 3 || !"--offline-confirmed".equals(args[2]))) {
            throw new IllegalArgumentException("Usage: plan <request.json> | (begin|retire|complete) <request.json> --offline-confirmed");
        }
        Path file = Path.of(args[1]);
        if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS) || Files.size(file) > 4 * 1024 * 1024) {
            throw new IllegalArgumentException("Invalid re-attestation request file");
        }
        var json = new ObjectMapper().enable(DeserializationFeature.USE_LONG_FOR_INTS);
        JsonNode request = json.readTree(Files.readAllBytes(file));
        String boot = MacOsHostIdentity.bootId();
        String previous = request.path("previousBootId").asText();
        if (!"Mac OS X".equals(System.getProperty("os.name"))
                || !boot.equals(request.path("currentBootId").asText()) || boot.equals(previous)
                || !previous.matches("[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}")) {
            throw new IllegalStateException("Native whole-host reboot evidence differs");
        }
        var source = new DriverManagerDataSource(required("W1_JDBC_URL"), required("W1_JDBC_USER"), present("W1_JDBC_PASSWORD"));
        var jdbc = new ManagedSchemaJdbcTemplate(source);
        String hardware = MacOsHostIdentity.machineId().replace("-", "").toLowerCase(java.util.Locale.ROOT);
        for (String saved : jdbc.queryForList("SELECT b.resource_handle_json FROM ma_runtime_binding b"
                + " JOIN ma_storage s ON s.tenant_id = b.tenant_id AND s.storage_id = b.storage_id WHERE s.physical_id = ?"
                + " AND b.is_provision_seeded = TRUE", String.class, request.path("physicalKey").asText())) {
            JsonNode handle = json.readTree(saved);
            if (!previous.equals(handle.path("bootId").asText()) || !hardware.equals(handle.path("hostId").asText())
                    || !"macos".equals(handle.path("pidNamespace").asText()) || !"macos".equals(handle.path("timeNamespace").asText())) {
                throw new IllegalStateException("Original Runtime boot/host evidence differs");
            }
        }
        var manager = new DataSourceTransactionManager(source);
        var properties = new ManagedAgentProperties();
        properties.getRuntimeBroker().setVerifiedWorkspaceRecoveryEnabled(true);
        properties.getRuntimeBroker().setStateDirectory(required("W1_STATE_DIRECTORY"));
        properties.getRuntimeBroker().setWorkspaceCreationRoot(System.getenv("W1_WORKSPACE_CREATION_ROOT"));
        var identities = new NativeStorageIdentityReader();
        var guard = new WorkspaceStorageGuard(jdbc, manager, properties, identities);
        var store = new WorkspaceIdentityReattestationStore(jdbc, manager, guard, identities, new LocalWorktreeFiles());
        switch (args[0]) {
            case "plan" -> System.out.println(json.writeValueAsString(store.plan(request)));
            case "begin" -> store.begin(request);
            case "complete" -> store.complete(request);
            case "retire" -> {
                var bindings = new JdbcRuntimeBindingRepository(source, AesGcmSecretProtector.fromBase64(
                        required("W1_RUNTIME_CREDENTIAL_KEY_ID"), required("W1_RUNTIME_CREDENTIAL_KEY")));
                var sessions = new JdbcRuntimeSessionRepository(source);
                var executions = new JdbcToolExecutionRepository(source, bindings);
                var ownership = new JdbcWorkspaceExecutionStore(jdbc, manager);
                var http = new HttpRuntimeTransport();
                properties.getRuntimeBroker().setDurableLocalProcess(true);
                properties.getRuntimeBroker().setTrustedLocalRebootRecovery(true);
                properties.getRuntimeBroker().setProvisioner(RuntimeProviderKinds.LOCAL_PROCESS);
                var local = new RuntimeProviderRegistry().require(RuntimeProviderKinds.LOCAL_PROCESS)
                        .createForMaintenance(properties.getRuntimeBroker(), http);
                var transport = new WorkspaceRuntimeTransport(http, ownership, bindings, sessions,
                        session -> { throw WorkspaceExecutionStore.unavailable(); });
                try (var broker = new RuntimeBrokerService(session -> CompletableFuture.failedFuture(
                        new IllegalStateException("Offline re-attestation never admits execution")),
                        new WorkspaceRuntimeProvisioner(local, null, ownership), transport,
                        bindings, sessions, executions, UUID.randomUUID().toString(), Duration.ofSeconds(30), Duration.ofSeconds(30))) {
                    store.retire(request, broker, bindings, local);
                }
            }
            default -> throw new IllegalArgumentException("Unknown re-attestation command");
        }
    }

    private static String required(String key) {
        String value = present(key);
        if (value.isBlank()) {
            throw new IllegalStateException("Missing " + key);
        }
        return value;
    }

    private static String present(String key) {
        String value = System.getenv(key);
        if (value == null) {
            throw new IllegalStateException("Missing " + key);
        }
        return value;
    }
}
