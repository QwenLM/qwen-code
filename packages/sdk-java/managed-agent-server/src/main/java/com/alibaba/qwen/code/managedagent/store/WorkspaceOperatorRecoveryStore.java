package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/** Durable, exact-holder operator authority. The caller must independently verify quiescence. */
public final class WorkspaceOperatorRecoveryStore {
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;
    private final RuntimeBindingRepository bindings;
    private final ObjectMapper json;

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
        String recoveryId = jdbc.query("SELECT recovery_id FROM managed_workspace_operator_recovery"
                + " WHERE binding_id = ? AND runtime_generation = ?", row ->
                        row.next() ? row.getString(1) : null, bindingId, generation);
        return new Inspection(bindingId, generation, binding.getState().name(),
                holder.holderKey(), holder.runtimeSessionId(), capture.callId(),
                capture.status(), capture.reason(), recoveryId == null && canPrepare(binding), recoveryId);
    }

    public String prepare(String bindingId, long generation, String expectedHolder,
            String operator, String reason) {
        if (expectedHolder == null || !expectedHolder.matches("[0-9a-f]{64}")
                || operator == null || operator.isBlank() || operator.length() > 512
                || reason == null || reason.isBlank() || reason.length() > 2048) {
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
                    + " FROM qwen_runtime_binding WHERE binding_id = ? FOR UPDATE", (row, index) ->
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
            String prior = jdbc.query("SELECT recovery_id, operator_id, reason FROM"
                    + " managed_workspace_operator_recovery WHERE binding_id = ?"
                    + " AND runtime_generation = ?", row -> {
                        if (!row.next()) {
                            return null;
                        }
                        if (!operator.equals(row.getString("operator_id"))
                                || !reason.equals(row.getString("reason"))) {
                            throw blocked();
                        }
                        return row.getString("recovery_id");
                    }, bindingId, generation);
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
            jdbc.update("INSERT INTO managed_workspace_operator_recovery"
                    + " (recovery_id, binding_id, runtime_generation, storage_key, holder_key,"
                    + " runtime_session_id, provision_request_id, resource_handle_json,"
                    + " runtime_lease_id, runtime_epoch, blocked_execution_call_id,"
                    + " operator_id, reason, prepared_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    recoveryId, bindingId, generation, current.storageKey(), current.holderKey(),
                    current.runtimeSessionId(), saved.getProvisionSeed().getProvisionRequestId(),
                    json.valueToTree(saved.getResourceHandle().getValue()).toString(),
                    saved.getLease().getLeaseId(), saved.getLease().getEpoch(),
                    blockedCapture.callId(), operator, reason,
                    LocalDateTime.ofInstant(Instant.now(), ZoneOffset.UTC));
            if (jdbc.update("UPDATE qwen_runtime_binding SET binding_state = ?,"
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
        List<Operation> found = jdbc.query("SELECT recovery_id, binding_id, runtime_generation,"
                + " storage_key, holder_key, runtime_session_id, prepared_at,"
                + " attestation_sha256, completed_at"
                + " FROM managed_workspace_operator_recovery"
                + " WHERE recovery_id = ?", (row, index) -> new Operation(
                        row.getString("recovery_id"), row.getString("binding_id"),
                        row.getLong("runtime_generation"), row.getString("storage_key"),
                        row.getString("holder_key"), row.getString("runtime_session_id"),
                        row.getObject("prepared_at", LocalDateTime.class).toInstant(ZoneOffset.UTC),
                        row.getString("attestation_sha256"), row.getTimestamp("completed_at") != null),
                recoveryId);
        if (found.size() != 1) {
            throw blocked();
        }
        return found.getFirst();
    }

    public void attest(Operation operation, byte[] evidence) {
        String digest = digest(evidence);
        transaction.executeWithoutResult(status -> {
            List<String> hashes = jdbc.query("SELECT attestation_sha256 FROM"
                    + " managed_workspace_operator_recovery WHERE recovery_id = ? FOR UPDATE",
                    (row, index) -> row.getString(1), operation.recoveryId());
            if (hashes.size() != 1) {
                throw blocked();
            }
            if (hashes.getFirst() != null) {
                if (!digest.equals(hashes.getFirst())) {
                    throw blocked();
                }
                return;
            }
            requireHeld(operation);
            jdbc.update("UPDATE managed_workspace_operator_recovery"
                    + " SET attestation_json = ?, attestation_sha256 = ?,"
                    + " attested_at = ? WHERE recovery_id = ?"
                    + " AND attestation_sha256 IS NULL",
                    new String(evidence, StandardCharsets.UTF_8), digest,
                    LocalDateTime.ofInstant(Instant.now(), ZoneOffset.UTC), operation.recoveryId());
        });
    }

    public void requireHeld(Operation operation) {
        List<Boolean> holders = jdbc.query("SELECT holder_key, binding_id, runtime_generation,"
                + " runtime_session_id FROM managed_workspace_execution_lease"
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
        List<Boolean> exact = jdbc.query("SELECT provision_request_id, resource_handle_json,"
                + " runtime_lease_id, runtime_epoch, storage_key, runtime_session_id, holder_key"
                + " FROM managed_workspace_operator_recovery WHERE recovery_id = ?",
                (row, index) -> binding != null
                        && binding.getGeneration() == operation.generation()
                        && binding.getBindingId().equals(operation.bindingId())
                        && binding.getProvisionSeed().getProvisionRequestId().equals(
                                row.getString("provision_request_id"))
                        && json.valueToTree(binding.getResourceHandle().getValue()).toString().equals(
                                row.getString("resource_handle_json"))
                        && binding.getLease().getLeaseId().equals(row.getString("runtime_lease_id"))
                        && binding.getLease().getEpoch() == row.getLong("runtime_epoch")
                        && digest(binding.getRequest().getScope().getTenantId() + "\u0000"
                                + binding.getRequest().getStorageId()).equals(row.getString("storage_key"))
                        && operation.holderKey().equals(row.getString("holder_key"))
                        && operation.holderKey().equals(digest(binding.getBindingId() + "\u0000"
                                + binding.getGeneration() + "\u0000"
                                + row.getString("runtime_session_id"))),
                operation.recoveryId());
        if (exact.size() != 1 || !exact.getFirst()) {
            throw blocked();
        }
    }

    public void complete(Operation operation) {
        transaction.executeWithoutResult(status -> {
            List<String> hashes = jdbc.query("SELECT attestation_sha256 FROM"
                    + " managed_workspace_operator_recovery WHERE recovery_id = ? FOR UPDATE",
                    (row, index) -> row.getString(1), operation.recoveryId());
            if (hashes.size() != 1 || hashes.getFirst() == null) {
                throw blocked();
            }
            RuntimeBindingRecord binding = bindings.findById(operation.bindingId());
            if (binding == null || binding.getGeneration() != operation.generation()
                    || binding.getState() != RuntimeBindingRecord.State.RELEASED
                    || binding.getStopEvidence() == null
                    || !("operator-attested:" + operation.recoveryId()).equals(
                            binding.getStopEvidence().source())) {
                throw blocked();
            }
            jdbc.update("UPDATE managed_workspace_operator_recovery SET completed_at ="
                    + " COALESCE(completed_at, ?) WHERE recovery_id = ?",
                    LocalDateTime.ofInstant(Instant.now(), ZoneOffset.UTC), operation.recoveryId());
        });
    }

    private RuntimeBindingRecord requireBinding(String bindingId, long generation) {
        RuntimeBindingRecord binding = bindings.findById(bindingId);
        if (binding == null || binding.getGeneration() != generation
                || !binding.getRequest().isManagedContext()
                || binding.getResourceHandle() == null
                || !"local-process".equals(binding.getResourceHandle().getKind())
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
        String storageKey = digest(binding.getRequest().getScope().getTenantId()
                + "\u0000" + binding.getRequest().getStorageId());
        String sql = "SELECT storage_key, holder_key, binding_id, runtime_generation,"
                + " runtime_session_id FROM managed_workspace_execution_lease"
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
                + " FROM qwen_tool_execution WHERE binding_id = ? AND runtime_generation = ?"
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
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value));
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }

    private static IllegalStateException blocked() {
        return new IllegalStateException("Exact Hosted Shell operator recovery is unavailable.");
    }
}
