package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties.RuntimeBroker.WorkspaceMount;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** Two-process manual acceptance fixture; only the coordinating operator may reboot its host. */
public final class WorkspaceMaintenanceLinuxAcceptanceMain {
    private static final ObjectMapper JSON = new ObjectMapper();

    private WorkspaceMaintenanceLinuxAcceptanceMain() {}

    public static void main(String[] args) throws Exception {
        if (args.length != 2 || !List.of("stage", "after").contains(args[0])
                || !Files.isReadable(Path.of("/proc/sys/kernel/random/boot_id"))) {
            throw new IllegalArgumentException("stage|after <task-owned-persistent-directory> on Linux");
        }
        Path root = Path.of(args[1]).toRealPath();
        var source = new DriverManagerDataSource(required("W1_JDBC_URL"), required("W1_JDBC_USER"),
                System.getenv().getOrDefault("W1_JDBC_PASSWORD", ""));
        ManagedSchema.initialize(source);
        var jdbc = new ManagedSchemaJdbcTemplate(source);
        var manager = new DataSourceTransactionManager(source);
        var transactions = new TransactionTemplate(manager);
        Path stateFile = root.resolve("native-maintenance-fixture.json");
        Map<String, Object> state;
        if ("stage".equals(args[0])) {
            if (Files.exists(stateFile)) {
                throw new IllegalStateException("Use a fresh task directory and database for staging");
            }
            state = new LinkedHashMap<>();
            state.put("tenant", "linux-native-" + UUID.randomUUID());
            state.put("workspace", "workspace");
            state.put("storage", "storage");
        } else {
            state = JSON.readValue(Files.readAllBytes(stateFile), new com.fasterxml.jackson.core.type.TypeReference<>() {});
        }
        String tenant = (String) state.get("tenant");
        var properties = new ManagedAgentProperties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        properties.getRuntimeBroker().setVerifiedWorkspaceRecoveryEnabled(true);
        properties.getRuntimeBroker().setWorkspaceMounts(List.of(new WorkspaceMount(tenant, "storage", root.toString())));
        var guard = new WorkspaceStorageGuard(jdbc, manager, properties);
        var authority = new WorkspaceExecutionStore(jdbc, manager, guard);
        var children = new ChildWorkspaceStore(jdbc, manager);
        var recovery = new WorkspaceMaintenanceRecovery(jdbc, manager, guard);
        var binding = new ContextBinding(tenant, "workspace", 1, "storage", ".", WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, 1);
        if ("stage".equals(args[0])) {
            guard.register(tenant, "storage", UUID.randomUUID().toString());
            jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation, storage_id, display_name, config_ref, policy_ref, state)"
                    + " VALUES (?, 'workspace', 1, 'storage', 'Native fixture', ?, ?, 'ACTIVE')",
                    tenant, WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
            jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role) VALUES (?, 'workspace', ?, 'OPERATOR')",
                    tenant, "native-actor".getBytes(java.nio.charset.StandardCharsets.UTF_8));
            var sessions = new ManagedAgentStore(jdbc, JSON, Clock.systemUTC(), ignored -> {}, new ManagedWorkspaceRegistry(jdbc), properties);
            String parent = transactions.execute(ignored -> sessions.insertWorkspaceSessionCommand(tenant, "native-actor", "create", "digest",
                    "qwen-code", null, null, List.of(), null, new WorkspaceSelection("workspace", "."))).sessionId();
            var child = children.admit(tenant, parent, "run", binding, System.currentTimeMillis());
            var claimed = children.claim(child, "original-native-worker", System.currentTimeMillis(), 60_000);
            authority.holdForMaintenance(binding, claimed.childWorkspaceId(), claimed.claimGeneration());
            var original = recovery.inspect(binding, claimed.childWorkspaceId(), claimed.claimGeneration());
            if (!Boolean.TRUE.equals(((Map<?, ?>) original.get("host")).get("available"))) {
                throw new IllegalStateException("Native boot identity was unavailable");
            }
            state.put("parent", parent);
            state.put("maintenance", claimed.childWorkspaceId());
            state.put("generation", claimed.claimGeneration());
            state.put("executionId", original.get("executionId"));
            state.put("originalIdentity", original);
            Path fifo = root.resolve("native-git-input.fifo");
            if (new ProcessBuilder("mkfifo", fifo.toString()).start().waitFor() != 0) {
                throw new IllegalStateException("Cannot create the task FIFO");
            }
            Process keeper = new ProcessBuilder("sh", "-c", "exec tail -f /dev/null > \"$1\"", "fixture-keeper", fifo.toString()).start();
            Process git = new ProcessBuilder("git", "hash-object", "--stdin").directory(root.toFile())
                    .redirectInput(fifo.toFile()).redirectOutput(root.resolve("native-git-output").toFile())
                    .redirectError(root.resolve("native-git-error").toFile()).start();
            if (!git.isAlive() || !keeper.isAlive()) {
                throw new IllegalStateException("The real Git fixture did not stay running");
            }
            state.put("jvmPid", ProcessHandle.current().pid());
            state.put("gitPid", git.pid());
            state.put("keeperPid", keeper.pid());
            Files.write(stateFile, JSON.writeValueAsBytes(state));
            requireBlocked(() -> recovery.reconcileAfterReboot(binding, claimed.childWorkspaceId(), claimed.claimGeneration(), (String) original.get("executionId")));
            jdbc.update("UPDATE ma_operation SET claim_until = (" + ManagedSchemaTime.SQL_NOW + " + -1000) WHERE operation_kind = 'CHILD_WORKSPACE' AND operation_id = ? AND claim_generation = ? AND tenant_id = ?",
                    claimed.childWorkspaceId(), claimed.claimGeneration(), tenant);
            if (children.claim(child, "replacement-before-reboot", System.currentTimeMillis(), 60_000) != null) {
                throw new IllegalStateException("Expiry replaced an original physical hold");
            }
            System.out.println(JSON.writeValueAsString(state));
            System.out.flush();
            Thread.sleep(Long.MAX_VALUE);
        } else {
            String maintenance = (String) state.get("maintenance");
            long generation = ((Number) state.get("generation")).longValue();
            String execution = (String) state.get("executionId");
            var before = recovery.inspect(binding, maintenance, generation);
            if (!execution.equals(before.get("executionId"))) {
                throw new IllegalStateException("Original execution identity changed");
            }
            var child = children.find(tenant, (String) state.get("parent"), "run");
            if (children.claim(child, "replacement-before-proof", System.currentTimeMillis(), 60_000) != null) {
                throw new IllegalStateException("Restart alone released a physical hold");
            }
            var stopped = recovery.reconcileAfterReboot(binding, maintenance, generation, execution);
            if (!"STOPPED".equals(stopped.get("state"))) {
                throw new IllegalStateException("Trusted reboot proof was not settled");
            }
            var replacement = children.claim(child, "replacement-after-proof", System.currentTimeMillis(), 60_000);
            if (replacement == null || replacement.claimGeneration() != generation + 1) {
                throw new IllegalStateException("The original generation was not preserved");
            }
            String successorStep = authority.holdForMaintenance(binding, maintenance, replacement.claimGeneration());
            authority.releaseMaintenance(binding, maintenance, generation, execution);
            if (jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage_owner WHERE maintenance_id = ? AND maintenance_generation = ? AND holder_key IS NOT NULL",
                    Integer.class, maintenance, replacement.claimGeneration()) != 1) {
                throw new IllegalStateException("An old generation erased the successor hold");
            }
            authority.releaseMaintenance(binding, maintenance, replacement.claimGeneration(), successorStep);
            System.out.println(JSON.writeValueAsString(Map.of("reconciled", true, "originalGeneration", generation,
                    "replacementGeneration", replacement.claimGeneration(), "originalExecutionId", execution, "proof", stopped)));
        }
    }

    private static void requireBlocked(Runnable action) {
        try {
            action.run();
            throw new IllegalStateException("Same-boot reconciliation was admitted");
        } catch (RuntimeBrokerException expected) {
            if (!"maintenance_stop_unverified".equals(expected.getCode())) {
                throw expected;
            }
        }
    }

    private static String required(String key) {
        String value = System.getenv(key);
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(key + " is required");
        }
        return value;
    }
}
