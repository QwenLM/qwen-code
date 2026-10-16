package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.runtimebroker.HarnessOwnership;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.LocalProcessRuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.codec.digest.DigestUtils;
import org.apache.commons.lang3.StringUtils;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** Durable, exact-holder operator authority. The caller must independently verify quiescence. */
public final class WorkspaceOperatorRecoveryStore {
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;
    private final RuntimeBindingRepository bindings;
    private final ObjectMapper json;
    private static final WorkspaceOperations.Kind KIND = WorkspaceOperations.Kind.WORKSPACE_OPERATOR_RECOVERY;

    public record Inspection(String bindingId, long generation, String state,
            String holderKey, String runtimeSessionId, String executionCallId,
            String captureStatus, String captureReason, boolean eligibleForPrepare,
            String recoveryId) {
    }

    public record Operation(String recoveryId, String bindingId, long generation,
            String storageKey, String holderKey, String runtimeSessionId,
            Instant preparedAt, String attestationHash, boolean completed) {
    }

    private record Holder(String storageKey, String holderKey, String bindingId,
            long generation, String runtimeSessionId) {
    }

    private record Capture(String callId, String status, String reason) {
    }

    public WorkspaceOperatorRecoveryStore(JdbcTemplate jdbc,
            PlatformTransactionManager manager, RuntimeBindingRepository bindings,
            ObjectMapper json) {
        this.jdbc = jdbc;
        this.transaction = new TransactionTemplate(manager);
        this.bindings = bindings;
        this.json = json;
    }

    public Inspection inspect(String bindingId, long generation) {
        RuntimeBindingRecord binding = requireBinding(bindingId, generation);
        Holder holder = holder(binding, false);
        Capture capture = capture(bindingId, generation, holder.runtimeSessionId());
        Map<String, Object> saved = findBindingOperation(binding, false);
        String recoveryId = saved == null ? null : (String) saved.get("operation_id");
        return new Inspection(bindingId, generation, binding.getState().name(),
                holder.holderKey(), holder.runtimeSessionId(), capture.callId(),
                capture.status(), capture.reason(), recoveryId == null && canPrepare(binding), recoveryId);
    }

    public String prepare(String bindingId, long generation, String expectedHolder,
            String operator, String reason) {
        if (expectedHolder == null || !expectedHolder.matches("[0-9a-f]{64}")
                || StringUtils.isBlank(operator) || operator.length() > 512
                || StringUtils.isBlank(reason) || reason.length() > 2048) {
            throw blocked();
        }
        RuntimeBindingRecord saved = requireBinding(bindingId, generation);
        return transaction.execute(status -> {
            jdbc.execute((ConnectionCallback<Void>) connection -> {
                JdbcRuntimeBindingRepository.lockPlacementDomain(connection,
                        saved.getRequest().getScope().getTenantId());
                return null;
            });
            List<Boolean> valid = jdbc.query("SELECT binding_state, record_version,"
                    + " resource_handle_version, provision_request_id, runtime_lease_id,"
                    + " runtime_epoch, storage_id, tenant_id, stop_evidence_json"
                    + " FROM ma_runtime_binding WHERE binding_id = ? FOR UPDATE", (row, index) ->
                            saved.getVersion() == row.getLong("record_version")
                            && saved.getState().name().equals(row.getString("binding_state"))
                            && row.getInt("resource_handle_version") == 2
                            && saved.getProvisionSeed().getProvisionRequestId().equals(
                                    row.getString("provision_request_id"))
                            && saved.getLease().getLeaseId().equals(row.getString("runtime_lease_id"))
                            && saved.getLease().getEpoch() == row.getLong("runtime_epoch")
                            && saved.getRequest().getStorageId().equals(row.getString("storage_id"))
                            && saved.getRequest().getScope().getTenantId().equals(row.getString("tenant_id"))
                            && row.getString("stop_evidence_json") == null,
                    bindingId);
            if (valid.size() != 1 || !valid.getFirst()) {
                throw blocked();
            }
            Holder current = holder(saved, true);
            if (!expectedHolder.equals(current.holderKey())) {
                throw blocked();
            }
            Capture blockedCapture = capture(bindingId, generation, current.runtimeSessionId());
            Map<String, Object> priorRow = findBindingOperation(saved, true);
            String prior = priorRow == null ? null : (String) priorRow.get("operation_id");
            if (priorRow != null && (!operator.equals(priorRow.get("operator_id"))
                    || !reason.equals(priorRow.get("reason")))) {
                throw blocked();
            }
            if (prior != null) {
                Operation operation = operation(prior);
                if (!expectedHolder.equals(operation.holderKey())) {
                    throw blocked();
                }
                return prior;
            }
            if (!canPrepare(saved)) {
                throw blocked();
            }
            String recoveryId = UUID.randomUUID().toString();
            new WorkspaceOperations(jdbc, saved.getRequest().getScope().getTenantId()).create(KIND, recoveryId,
                    WorkspaceOperations.values("state", "PREPARED", "binding_id", bindingId,
                            "session_id", sessionOwner(saved, current.runtimeSessionId()),
                            "runtime_generation", generation, "storage_id", saved.getRequest().getStorageId(),
                            "storage_key", current.storageKey(), "holder_key", current.holderKey(),
                            "runtime_session_id", current.runtimeSessionId(),
                            "provision_request_id", saved.getProvisionSeed().getProvisionRequestId(),
                            "resource_handle_json", json.valueToTree(saved.getResourceHandle().getValue()).toString(),
                            "runtime_lease_id", saved.getLease().getLeaseId(), "runtime_epoch", saved.getLease().getEpoch(),
                            "blocked_execution_call_id", blockedCapture.callId(), "operator_id", operator,
                            "reason", reason, "prepared_at", Instant.now().toString()));
            if (jdbc.update("UPDATE ma_runtime_binding SET binding_state = ?,"
                    + " drain_requested = TRUE, operation_owner = NULL, operation_lease_until = NULL,"
                    + " operation_generation = operation_generation + 1, record_version = record_version + 1"
                    + " WHERE binding_id = ? AND runtime_generation = ? AND record_version = ?",
                    saved.getState() == RuntimeBindingRecord.State.LOST ? "LOST" : "OPERATOR_RECOVERY",
                    bindingId, generation, saved.getVersion()) != 1) {
                throw blocked();
            }
            return recoveryId;
        });
    }

    public Operation operation(String recoveryId) {
        Map<String, Object> row = row(recoveryId, false);
        return new Operation(recoveryId, (String) row.get("binding_id"),
                ((Number) row.get("runtime_generation")).longValue(), (String) row.get("storage_key"),
                (String) row.get("holder_key"), (String) row.get("runtime_session_id"),
                Instant.parse((String) row.get("prepared_at")), (String) row.get("attestation_sha256"),
                "COMPLETED".equals(row.get("state")));
    }

    public void attest(Operation operation, byte[] evidence) {
        String digest = digest(evidence);
        transaction.executeWithoutResult(status -> {
            Map<String, Object> row = row(operation.recoveryId(), true);
            if (row.get("attestation_sha256") != null) {
                if (!digest.equals(row.get("attestation_sha256"))) {
                    throw blocked();
                }
                return;
            }
            requireHeld(operation);
            RuntimeBindingRecord binding = requireBinding(operation.bindingId(), operation.generation());
            WorkspaceOperations operations = new WorkspaceOperations(jdbc, (String) row.get("tenant_id"));
            String target = digest((String) row.get("blocked_execution_call_id"));
            String owner = WorkspaceOperations.hash(operations.key(KIND, operation.recoveryId()), "RECOVERY_EVIDENCE", target);
            String sessionId = HarnessOwnership.sharesRuntimeSessions(binding.getRequest())
                    ? (String) row.get("session_id") : binding.getRequest().getIsolationKey();
            String resource = WorkspaceEvidenceResources.publish(jdbc, (String) row.get("tenant_id"),
                    binding.getRequest().getScope().getWorkspaceId(), sessionId, owner, evidence);
            operations.insertWork(KIND, operation.recoveryId(), "RECOVERY_EVIDENCE", target,
                    (String) row.get("blocked_execution_call_id"), sessionId,
                    WorkspaceOperations.values("evidence_resource_key", resource, "evidence_sha256", digest), "COMPLETE");
            operations.update(KIND, operation.recoveryId(), WorkspaceOperations.values("attestation_resource_key", resource,
                    "attestation_sha256", digest, "attested_at", Instant.now().toString(), "state", "ATTESTED"));
        });
    }

    public void requireHeld(Operation operation) {
        List<Boolean> holders = jdbc.query("SELECT holder_key, binding_id, runtime_generation,"
                + " runtime_session_id FROM ma_storage_owner"
                + " WHERE storage_key = ? AND storage_kind = 'LOCAL' FOR UPDATE",
                (row, index) -> operation.holderKey().equals(row.getString("holder_key"))
                        && operation.bindingId().equals(row.getString("binding_id"))
                        && operation.generation() == row.getLong("runtime_generation")
                        && operation.runtimeSessionId().equals(row.getString("runtime_session_id")),
                operation.storageKey());
        if (holders.size() != 1 || !holders.getFirst()) {
            throw blocked();
        }
    }

    public void requireSnapshot(Operation operation, RuntimeBindingRecord binding) {
        Map<String, Object> row = row(operation.recoveryId(), false);
        if (binding == null || binding.getGeneration() != operation.generation()
                || !binding.getBindingId().equals(operation.bindingId())
                || !binding.getProvisionSeed().getProvisionRequestId().equals(row.get("provision_request_id"))
                || !json.valueToTree(binding.getResourceHandle().getValue()).toString().equals(row.get("resource_handle_json"))
                || !binding.getLease().getLeaseId().equals(row.get("runtime_lease_id"))
                || binding.getLease().getEpoch() != ((Number) row.get("runtime_epoch")).longValue()
                || !LocalStorageOwners.key(jdbc, binding.getRequest().getScope().getTenantId(),
                        binding.getRequest().getStorageId()).equals(row.get("storage_key"))
                || !operation.holderKey().equals(row.get("holder_key"))
                || !operation.holderKey().equals(digest(binding.getBindingId() + "\u0000"
                        + binding.getGeneration() + "\u0000" + row.get("runtime_session_id")))) {
            throw blocked();
        }
    }

    public void complete(Operation operation) {
        transaction.executeWithoutResult(status -> {
            Map<String, Object> row = row(operation.recoveryId(), true);
            if (row.get("attestation_sha256") == null) {
                throw blocked();
            }
            RuntimeBindingRecord binding = bindings.findById(operation.bindingId());
            if (binding == null || binding.getGeneration() != operation.generation()
                    || binding.getState() != RuntimeBindingRecord.State.RELEASED || binding.getStopEvidence() == null
                    || !("operator-attested:" + operation.recoveryId()).equals(binding.getStopEvidence().source())) {
                throw blocked();
            }
            new WorkspaceOperations(jdbc, (String) row.get("tenant_id")).update(KIND, operation.recoveryId(),
                    WorkspaceOperations.values("completed_at", row.get("completed_at") == null
                            ? Instant.now().toString() : row.get("completed_at"), "state", "COMPLETED"));
        });
    }

    /** The held Runtime Session's Harness Session: a shared binding's isolation key names no owner. */
    private String sessionOwner(RuntimeBindingRecord binding, String runtimeSessionId) {
        if (!HarnessOwnership.sharesRuntimeSessions(binding.getRequest())) {
            return binding.getRequest().getIsolationKey();
        }
        List<String> owners = jdbc.queryForList("SELECT harness_session_id FROM ma_runtime_session WHERE binding_id = ?"
                + " AND runtime_generation = ? AND runtime_session_id = ?", String.class,
                binding.getBindingId(), binding.getGeneration(), runtimeSessionId);
        if (owners.size() != 1) {
            throw blocked();
        }
        return owners.getFirst();
    }

    private Map<String, Object> row(String recoveryId, boolean lock) {
        List<Map<String, Object>> rows = jdbc.query("SELECT " + ManagedSchemaProjection.OPERATION.columns() + " FROM ma_operation WHERE operation_kind = ?"
                + " AND operation_id = ?" + (lock ? " FOR UPDATE" : ""),
                (row, index) -> WorkspaceOperations.operation(row), KIND.name(), recoveryId.getBytes(StandardCharsets.UTF_8));
        if (rows.size() != 1) {
            throw blocked();
        }
        return rows.getFirst();
    }

    private Map<String, Object> findBindingOperation(RuntimeBindingRecord binding, boolean lock) {
        List<Map<String, Object>> rows = jdbc.query("SELECT " + ManagedSchemaProjection.OPERATION.columns() + " FROM ma_operation WHERE operation_kind = ?"
                + " AND tenant_id = ? AND target_key = ? AND target_revision = ?" + (lock ? " FOR UPDATE" : ""),
                (row, index) -> WorkspaceOperations.operation(row), KIND.name(), binding.getRequest().getScope().getTenantId(),
                WorkspaceOperations.hash(binding.getBindingId()), binding.getGeneration());
        if (rows.size() > 1) {
            throw blocked();
        }
        return rows.isEmpty() ? null : rows.getFirst();
    }

    private RuntimeBindingRecord requireBinding(String bindingId, long generation) {
        RuntimeBindingRecord binding = bindings.findById(bindingId);
        if (binding == null || binding.getGeneration() != generation
                || !binding.getRequest().isManagedContext()
                || binding.getResourceHandle() == null
                || !LocalProcessRuntimeProvisioner.KIND.equals(binding.getResourceHandle().getKind())
                || binding.getResourceHandle().getVersion() != 2
                || binding.getProvisionSeed() == null || binding.getLease() == null) {
            throw blocked();
        }
        WorkspaceStorageKindGuard.requireLocalAlias(jdbc, binding.getRequest().getScope().getTenantId(),
                binding.getRequest().getStorageId());
        return binding;
    }

    private static boolean canPrepare(RuntimeBindingRecord binding) {
        return binding.getStopEvidence() == null
                && (binding.getState() == RuntimeBindingRecord.State.READY
                        || binding.getState() == RuntimeBindingRecord.State.DRAINING
                        || binding.getState() == RuntimeBindingRecord.State.RECOVERY_BLOCKED
                        || binding.getState() == RuntimeBindingRecord.State.LOST);
    }

    private Holder holder(RuntimeBindingRecord binding, boolean locked) {
        String bindingId = binding.getBindingId();
        long generation = binding.getGeneration();
        String storageKey = LocalStorageOwners.key(jdbc, binding.getRequest().getScope().getTenantId(), binding.getRequest().getStorageId());
        String sql = "SELECT storage_key, holder_key, binding_id, runtime_generation,"
                + " runtime_session_id FROM ma_storage_owner"
                + " WHERE storage_key = ? AND storage_kind = 'LOCAL' " + (locked ? " FOR UPDATE" : "");
        List<Holder> holders = jdbc.query(sql, (row, index) -> new Holder(
                row.getString("storage_key"), row.getString("holder_key"),
                row.getString("binding_id"), row.getLong("runtime_generation"),
                row.getString("runtime_session_id")), storageKey);
        if (holders.size() != 1 || holders.getFirst().holderKey() == null
                || holders.getFirst().runtimeSessionId() == null
                || !bindingId.equals(holders.getFirst().bindingId())
                || generation != holders.getFirst().generation()
                || !holders.getFirst().storageKey().equals(storageKey)
                || !holders.getFirst().holderKey().equals(digest(
                        bindingId + "\u0000" + generation + "\u0000"
                                + holders.getFirst().runtimeSessionId()))) {
            throw blocked();
        }
        return holders.getFirst();
    }

    private Capture capture(String bindingId, long generation, String sessionId) {
        List<Capture> captures = jdbc.query("SELECT execution_call_id, reference_json, result_json"
                + " FROM ma_tool_execution WHERE binding_id = ? AND runtime_generation = ?"
                + " AND execution_state = 'SETTLED' AND runtime_session_id = ?"
                + " AND result_json IS NOT NULL"
                + " ORDER BY settled_at DESC", (row, index) -> {
                    try {
                        JsonNode reference = json.readTree(row.getString("reference_json"));
                        JsonNode result = json.readTree(row.getString("result_json"));
                        // Protocol-3 deferred references omit toolName; dispatch admits only Shell.
                        boolean shell = "run_shell_command".equals(reference.path("toolName").asText())
                                || reference.path("runtimeProtocol").asInt() == 3
                                        && "deferred".equals(reference.path("dispatchMode").asText());
                        if (!shell || "complete".equals(result.path("capture")
                                .path("captureStatus").asText())) {
                            return null;
                        }
                        String captureStatus = result.path("capture").path("captureStatus").asText();
                        return !"producer_lost".equals(result.path("capture")
                                .path("captureReason").asText()) ? null : new Capture(
                                row.getString("execution_call_id"), captureStatus,
                                result.path("capture").path("captureReason").asText());
                    } catch (Exception error) {
                        throw blocked();
                    }
                }, bindingId, generation, sessionId);
        return captures.stream().filter(item -> item != null).findFirst().orElseThrow(
                WorkspaceOperatorRecoveryStore::blocked);
    }

    private static String digest(String value) {
        return digest(value.getBytes(StandardCharsets.UTF_8));
    }

    private static String digest(byte[] value) {
        try {
            return DigestUtils.sha256Hex(value);
        } catch (IllegalArgumentException error) {
            throw new IllegalStateException(error);
        }
    }

    private static IllegalStateException blocked() {
        return new IllegalStateException("Exact Hosted Shell operator recovery is unavailable.");
    }
}
