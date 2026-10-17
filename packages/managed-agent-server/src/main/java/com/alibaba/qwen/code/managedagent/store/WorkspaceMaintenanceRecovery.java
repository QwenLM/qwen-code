package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/** Offline reconciliation of the original Git step after a proven host reboot. */
public final class WorkspaceMaintenanceRecovery {
    private static final ObjectMapper JSON = new ObjectMapper()
            .enable(com.fasterxml.jackson.databind.DeserializationFeature.USE_LONG_FOR_INTS)
            .enable(com.fasterxml.jackson.databind.DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
            .enable(com.fasterxml.jackson.core.JsonParser.Feature.STRICT_DUPLICATE_DETECTION);
    private static final WorkspaceOperations.Kind KIND = WorkspaceOperations.Kind.CHILD_WORKSPACE;
    private static final String WORK_KIND = "RECOVERY_EVIDENCE";
    private static final String[] MOUNT_FIELDS = {"storage_key", "physical_key", "mount_revision", "mount_root",
            "mount_host_id", "mount_device", "mount_inode", "mount_birth_time", "mount_registration_id"};
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;
    private final WorkspaceStorageGuard guard;

    public WorkspaceMaintenanceRecovery(JdbcTemplate jdbc, PlatformTransactionManager manager, WorkspaceStorageGuard guard) {
        this.jdbc = jdbc;
        this.transaction = new TransactionTemplate(manager);
        this.guard = guard;
    }

    static String recordStart(JdbcTemplate jdbc, ContextBinding binding, String maintenance, long generation) {
        var operations = new WorkspaceOperations(jdbc, binding.getTenantId());
        String slot = target(maintenance, generation);
        var current = currentStep(jdbc, binding, maintenance, generation, true);
        if (current != null && "EXECUTING".equals(current.get("state"))) {
            throw blocked();
        }
        var owner = owner(jdbc, binding, true);
        var child = WorkspaceOperations.rows(jdbc, "SELECT parent_session_id FROM ma_workspace WHERE tenant_id = ?"
                + " AND child_workspace_id = ? AND workspace_kind = 'CHILD_GIT'", binding.getTenantId(), maintenance);
        if (owner == null || child.size() != 1 || !maintenance.equals(owner.get("maintenance_id"))
                || !(owner.get("maintenance_generation") instanceof Number saved) || saved.longValue() != generation) {
            throw blocked();
        }
        String session = (String) child.getFirst().get("parent_session_id");
        String execution = UUID.randomUUID().toString();
        String step = stepTarget(maintenance, generation, execution);
        Map<String, Object> identity = WorkspaceOperations.values("schemaVersion", 1, "kind", "child-git-maintenance",
                "maintenanceId", maintenance, "generation", generation, "executionId", execution,
                "tenantId", binding.getTenantId(), "workspaceId", binding.getWorkspaceId(),
                "workspaceGeneration", binding.getWorkspaceGeneration(), "storageId", binding.getStorageId(), "holderKey", owner.get("holder_key"),
                "mount", mount(owner), "host", nativeHost());
        byte[] bytes = bytes(identity);
        String resource = WorkspaceEvidenceResources.publish(jdbc, binding.getTenantId(), binding.getWorkspaceId(), session, step, bytes);
        operations.insertWork(KIND, maintenance, WORK_KIND, step, maintenance + ":" + generation + ":" + execution, session,
                WorkspaceOperations.values("execution_id", execution, "evidence_resource_key", resource,
                        "evidence_sha256", WorkspaceEvidenceResources.digest(bytes)), "EXECUTING");
        var pointer = WorkspaceOperations.values("execution_id", execution, "step_target", step);
        if (operations.findWork(KIND, maintenance, WORK_KIND, slot, true) == null) {
            operations.insertWork(KIND, maintenance, WORK_KIND, slot, maintenance + ":" + generation, session, pointer, "INDEX");
        } else {
            operations.updateWork(KIND, maintenance, WORK_KIND, slot, pointer);
        }
        return execution;
    }

    static boolean recordReturned(JdbcTemplate jdbc, ContextBinding binding, String maintenance, long generation, String execution) {
        var work = currentStep(jdbc, binding, maintenance, generation, true);
        if (work == null || !"EXECUTING".equals(work.get("state")) || !execution.equals(work.get("execution_id"))) {
            return false;
        }
        new WorkspaceOperations(jdbc, binding.getTenantId()).updateWork(KIND, maintenance, WORK_KIND,
                stepTarget(maintenance, generation, execution), Map.of("state", "RETURNED"));
        return true;
    }

    private static Map<String, Object> currentStep(JdbcTemplate jdbc, ContextBinding binding, String maintenance, long generation, boolean lock) {
        var operations = new WorkspaceOperations(jdbc, binding.getTenantId());
        var slot = operations.findWork(KIND, maintenance, WORK_KIND, target(maintenance, generation), lock);
        if (slot == null) {
            return null;
        }
        String execution = (String) slot.get("execution_id");
        if (execution == null || !"INDEX".equals(slot.get("state"))
                || !stepTarget(maintenance, generation, execution).equals(slot.get("step_target"))) {
            throw blocked();
        }
        return operations.findWork(KIND, maintenance, WORK_KIND, (String) slot.get("step_target"), lock);
    }

    public Map<String, Object> inspect(ContextBinding binding, String maintenance, long generation) {
        var work = currentStep(jdbc, binding, maintenance, generation, false);
        if (work == null) {
            throw blocked();
        }
        Map<String, Object> original = identity(work);
        validateIdentity(binding, maintenance, generation, original);
        Map<String, Object> result = new LinkedHashMap<>(original);
        result.put("state", work.get("state"));
        result.put("recoveryBlocker", "EXECUTING".equals(work.get("state")) ? "maintenance_stop_unverified" : null);
        return result;
    }

    public Map<String, Object> reconcileAfterReboot(ContextBinding binding, String maintenance, long generation, String executionId) {
        WorkspaceStorageKindGuard.requireFreshTransaction();
        if (guard == null || !guard.enabled()) {
            throw blocked();
        }
        Map<String, Object> observedHost = nativeHost();
        return transaction.execute(status -> {
            WorkspaceStorageKindGuard.lockDomain(jdbc, binding.getTenantId());
            var operations = new WorkspaceOperations(jdbc, binding.getTenantId());
            var work = operations.findWork(KIND, maintenance, WORK_KIND, stepTarget(maintenance, generation, executionId), true);
            if (work == null) {
                throw blocked();
            }
            var original = identity(work);
            validateIdentity(binding, maintenance, generation, original);
            if (!executionId.equals(original.get("executionId"))) {
                throw blocked();
            }
            if ("STOPPED".equals(work.get("state"))) {
                return inspect(binding, maintenance, generation);
            }
            var current = currentStep(jdbc, binding, maintenance, generation, true);
            if (!"EXECUTING".equals(work.get("state")) || current == null || !executionId.equals(current.get("execution_id"))) {
                throw blocked();
            }
            var before = JSON.convertValue(original.get("host"), new com.fasterxml.jackson.core.type.TypeReference<Map<String, Object>>() { });
            if (!Boolean.TRUE.equals(before.get("available")) || !Boolean.TRUE.equals(observedHost.get("available"))
                    || !before.get("hostId").equals(observedHost.get("hostId"))
                    || before.get("bootId").equals(observedHost.get("bootId"))) {
                throw blocked();
            }
            var held = owner(jdbc, binding, true);
            if (held == null || !maintenance.equals(held.get("maintenance_id"))
                    || !(held.get("maintenance_generation") instanceof Number saved) || saved.longValue() != generation
                    || !original.get("holderKey").equals(held.get("holder_key"))
                    || !JSON.valueToTree(original.get("mount")).equals(JSON.valueToTree(mount(held)))) {
                throw blocked();
            }
            guard.verifyMaintenanceRecovery(binding);
            var operation = operations.find(KIND, maintenance, true);
            if (operation == null) {
                throw blocked();
            }
            String proofTarget = WorkspaceOperations.hash(stepTarget(maintenance, generation, executionId), "stopped");
            byte[] proof = bytes(WorkspaceOperations.values("schemaVersion", 1, "kind", "trusted-host-reboot",
                    "original", original, "observedHost", observedHost));
            String session = (String) work.get("session_id");
            String resource = WorkspaceEvidenceResources.publish(jdbc, binding.getTenantId(), binding.getWorkspaceId(), session, proofTarget, proof);
            operations.insertWork(KIND, maintenance, WORK_KIND, proofTarget, maintenance + ":" + generation + ":" + executionId + ":stopped", session,
                    WorkspaceOperations.values("evidence_resource_key", resource, "evidence_sha256", WorkspaceEvidenceResources.digest(proof)), "STOPPED");
            operations.updateWork(KIND, maintenance, WORK_KIND, stepTarget(maintenance, generation, executionId), Map.of("state", "STOPPED"));
            if (jdbc.update("UPDATE ma_storage_owner SET holder_key = NULL, maintenance_id = NULL, maintenance_generation = NULL"
                            + " WHERE storage_key = ? AND maintenance_id = ? AND maintenance_generation = ? AND holder_key = ?",
                    WorkspaceExecutionStore.storageKey(jdbc, binding), maintenance, generation, original.get("holderKey")) != 1
                    || jdbc.update("UPDATE ma_operation SET gmt_modified = " + ManagedSchemaTime.SQL_NOW + ", claim_owner = NULL, claim_until = NULL WHERE operation_key = ? AND claim_generation = ?", operations.key(KIND, maintenance), generation) != 1) {
                throw blocked();
            }
            return inspect(binding, maintenance, generation);
        });
    }

    private Map<String, Object> identity(Map<String, Object> work) {
        try {
            return JSON.readValue(WorkspaceEvidenceResources.read(jdbc, (String) work.get("evidence_resource_key"), (String) work.get("evidence_sha256")), new com.fasterxml.jackson.core.type.TypeReference<>() { });
        } catch (java.io.IOException exception) {
            throw blocked();
        }
    }

    private static void validateIdentity(ContextBinding binding, String maintenance, long generation, Map<String, Object> original) {
        if (!(original.get("schemaVersion") instanceof Number version) || version.intValue() != 1
                || !"child-git-maintenance".equals(original.get("kind"))
                || !(original.get("executionId") instanceof String execution) || execution.isBlank()
                || !binding.getTenantId().equals(original.get("tenantId")) || !binding.getStorageId().equals(original.get("storageId"))
                || !binding.getWorkspaceId().equals(original.get("workspaceId"))
                || !(original.get("workspaceGeneration") instanceof Number workspaceGeneration)
                || binding.getWorkspaceGeneration() != workspaceGeneration.longValue()
                || !maintenance.equals(original.get("maintenanceId")) || !(original.get("generation") instanceof Number saved)
                || saved.longValue() != generation) {
            throw blocked();
        }
    }

    private static Map<String, Object> owner(JdbcTemplate jdbc, ContextBinding binding, boolean lock) {
        var rows = WorkspaceOperations.rows(jdbc, "SELECT " + ManagedSchemaProjection.STORAGE_OWNER.columns() + " FROM ma_storage_owner WHERE storage_key = ? AND storage_kind = 'LOCAL'"
                + (lock ? " FOR UPDATE" : ""), WorkspaceExecutionStore.storageKey(jdbc, binding));
        return rows.size() == 1 ? rows.getFirst() : null;
    }

    private static Map<String, Object> mount(Map<String, Object> owner) {
        Map<String, Object> result = new LinkedHashMap<>();
        for (String field : MOUNT_FIELDS) {
            result.put(field, owner.get(field));
        }
        return result;
    }

    private static Map<String, Object> nativeHost() {
        try {
            String host = Files.readString(Path.of("/etc/machine-id")).strip();
            String boot = Files.readString(Path.of("/proc/sys/kernel/random/boot_id")).strip();
            String pid = Files.readSymbolicLink(Path.of("/proc/self/ns/pid")).toString();
            String time = Files.readSymbolicLink(Path.of("/proc/self/ns/time")).toString();
            if (!host.matches("[a-f0-9]{32}") || !boot.matches("[a-f0-9-]{36}") || !pid.matches("pid:\\[[0-9]+]")
                    || !time.matches("time:\\[[0-9]+]")) {
                throw blocked();
            }
            return Map.of("available", true, "hostId", host, "bootId", boot, "pidNamespace", pid, "timeNamespace", time);
        } catch (java.io.IOException | RuntimeException unavailable) {
            return Map.of("available", false);
        }
    }

    private static byte[] bytes(Object value) {
        try {
            return JSON.writeValueAsBytes(value);
        } catch (java.io.IOException exception) {
            throw blocked();
        }
    }

    private static String stepTarget(String maintenance, long generation, String execution) {
        return WorkspaceOperations.hash(target(maintenance, generation), execution);
    }

    private static String target(String maintenance, long generation) {
        return WorkspaceOperations.hash("child-maintenance", maintenance, Long.toString(generation));
    }

    private static RuntimeBrokerException blocked() {
        return new RuntimeBrokerException(409, "maintenance_stop_unverified", "The original Git step needs trusted physical stop evidence.", false);
    }
}
