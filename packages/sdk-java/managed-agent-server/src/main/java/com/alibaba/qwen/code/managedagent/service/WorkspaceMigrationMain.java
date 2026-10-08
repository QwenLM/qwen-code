package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties.RuntimeBroker.WorkspaceMount;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.WorkspaceExecutionStore;
import com.alibaba.qwen.code.managedagent.store.WorkspaceMigrationStore;
import com.alibaba.qwen.code.managedagent.store.WorkspaceStorageGuard;
import com.alibaba.qwen.code.runtimebroker.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.HttpRuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.LocalProcessRuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerService;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

/** Private offline entry point, with no listeners or Worker acquisition. */
public final class WorkspaceMigrationMain {
    private WorkspaceMigrationMain() {
    }

    public static void main(String[] args) throws Exception {
        if (args.length < 2 || !Set.of("retire", "prepare", "promote", "inspect", "abort").contains(args[0])
                || ("inspect".equals(args[0]) ? args.length != 2
                        : args.length != 3 || !"--offline-confirmed".equals(args[2]))) {
            throw new IllegalArgumentException("Usage: (retire|prepare|promote|abort) <request.json> --offline-confirmed"
                    + " | inspect <request.json>");
        }
        Path input = Path.of(args[1]);
        if (!Files.isRegularFile(input, LinkOption.NOFOLLOW_LINKS) || Files.size(input) > 1024 * 1024) {
            throw new IllegalArgumentException("Invalid migration request file");
        }
        byte[] bytes = Files.readAllBytes(input);
        var request = new ObjectMapper().readTree(bytes);
        var source = new DriverManagerDataSource(required("W1_JDBC_URL"), required("W1_JDBC_USER"),
                present("W1_JDBC_PASSWORD"));
        var jdbc = new JdbcTemplate(source);
        var manager = new DataSourceTransactionManager(source);
        var properties = new ManagedAgentProperties();
        properties.getRuntimeBroker().setVerifiedWorkspaceRecoveryEnabled(true);
        properties.getRuntimeBroker().setWorkspaceMounts(List.of(new WorkspaceMount(request.path("tenantId").asText(),
                request.path("storageId").asText(), request.path("sourceRoot").asText())));
        var bindings = "inspect".equals(args[0]) ? null : new JdbcRuntimeBindingRepository(source,
                AesGcmSecretProtector.fromBase64(required("W1_RUNTIME_CREDENTIAL_KEY_ID"), required("W1_RUNTIME_CREDENTIAL_KEY")));
        var store = new WorkspaceMigrationStore(jdbc, manager, new WorkspaceStorageGuard(jdbc, manager, properties),
                bindings, bytes, "retire".equals(args[0]));
        if ("inspect".equals(args[0])) {
            System.out.println(store.inspect());
            return;
        }
        try {
            switch (args[0]) {
                case "abort" -> store.abort();
                case "prepare" -> store.verify(false);
                case "promote" -> store.verify(true);
                case "retire" -> {
                    var sessions = new JdbcRuntimeSessionRepository(source);
                    var executions = new JdbcToolExecutionRepository(source);
                    var ownership = new WorkspaceExecutionStore(jdbc, manager);
                    var http = new HttpRuntimeTransport();
                    Path stateDirectory = Path.of(request.path("stateDirectory").asText());
                    if (!Files.isDirectory(stateDirectory, LinkOption.NOFOLLOW_LINKS)
                            || !stateDirectory.equals(stateDirectory.toRealPath())) {
                        throw new IllegalStateException("Original Runtime state directory is unavailable");
                    }
                    var local = LocalProcessRuntimeProvisioner.durable(List.of("maintenance-never-starts-worker"),
                            stateDirectory, http, false);
                    var transport = new WorkspaceRuntimeTransport(http, ownership, bindings, sessions, sessionId -> {
                        var found = jdbc.query("SELECT * FROM managed_agent_session WHERE tenant_id = ? AND session_id = ?",
                                (row, index) -> ManagedAgentStore.readBinding(row),
                                request.path("tenantId").asText(), sessionId);
                        if (found.size() != 1 || found.getFirst() == null) {
                            throw WorkspaceExecutionStore.unavailable();
                        }
                        return found.getFirst();
                    });
                    try (var broker = new RuntimeBrokerService(session -> CompletableFuture.failedFuture(
                            new IllegalStateException("Maintenance never resolves active Sessions")),
                            new WorkspaceRuntimeProvisioner(local, null, ownership), transport,
                            bindings, sessions, executions, UUID.randomUUID().toString(), Duration.ofSeconds(30),
                            Duration.ofSeconds(30))) {
                        store.retire(broker);
                    }
                }
                default -> throw new IllegalArgumentException("Unknown migration command");
            }
        } catch (Exception error) {
            try {
                store.failed(com.alibaba.qwen.code.managedagent.store.WorkspaceRecoveryStore.errorCode(error));
            } catch (Exception recordingFailure) {
                error.addSuppressed(recordingFailure);
            }
            throw error;
        }
        System.out.println(store.inspect());
    }

    private static String required(String name) {
        String value = present(name);
        if (value.isBlank()) {
            throw new IllegalStateException("Missing " + name);
        }
        return value;
    }

    private static String present(String name) {
        String value = System.getenv(name);
        if (value == null) {
            throw new IllegalStateException("Missing " + name);
        }
        return value;
    }
}
