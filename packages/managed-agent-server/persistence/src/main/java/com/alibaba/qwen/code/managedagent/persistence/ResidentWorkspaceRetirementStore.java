package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.workspace.ResidentReclamation;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings.RuntimeBroker.ResidentWorkspace;
import com.alibaba.qwen.code.runtimebroker.CsiOwnershipRevision;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.spi.KubernetesMaintenanceClient;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

import static com.alibaba.qwen.code.managedagent.persistence.WorkspaceOperations.Kind.WORKSPACE_RETIREMENT;
import static com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity.digest;
import static com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity.map;
import static com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity.same;

/** Explicit idle maintenance with original platform cleanup and atomic ownership release. */
public final class ResidentWorkspaceRetirementStore implements com.alibaba.qwen.code.managedagent.repository.ResidentRetirementRepository {
    private static final String WORK = "POD_DELETE_ATTEMPT";
    private static final String FINALIZER_WORK = "POD_FINALIZER_ATTEMPT";
    private static final int PLAN_LIMIT = 256 * 1024;
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;
    private final JdbcRuntimeBindingRepository bindings;
    private final List<ResidentWorkspace> mappings;
    private final ObjectMapper json;

    @JsonInclude(JsonInclude.Include.NON_NULL)
    private record Plan(int version, Request request, String bindingId, long runtimeGeneration,
            String resourceIdentity, String mappingDigest, com.alibaba.qwen.code.managedagent.contracts.workspace.ResidentWorkspaceSnapshot mapping) { }

    public ResidentWorkspaceRetirementStore(JdbcTemplate jdbc, PlatformTransactionManager manager,
            JdbcRuntimeBindingRepository bindings, List<? extends ResidentWorkspace> mappings, ObjectMapper json) {
        require(jdbc.getDataSource() != null && bindings.usesDataSource(jdbc.getDataSource()));
        this.jdbc = jdbc;
        this.transaction = new TransactionTemplate(manager);
        transaction.setTimeout(10);
        this.bindings = bindings;
        new ResidentWorkspaces(mappings);
        this.mappings = List.copyOf(mappings);
        this.json = json.copy().enable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION)
                .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);
    }

    public Status inspect(Request request) {
        return transaction.execute(status -> {
            var saved = operations(request).find(WORKSPACE_RETIREMENT, request.retirementId(), false);
            if (saved == null) {
                authorize(request, false);
                return new Status(request.retirementId(), "NOT_STARTED", null, 0, List.of(), List.of(), null);
            }
            Plan plan = readPlan(request, saved);
            boolean released = "RELEASED".equals(saved.get("state"));
            var selected = released ? plan.mapping() : selected(request);
            require(selected != null && digest(selected).equals(plan.mappingDigest()));
            authorize(request, selected, false);
            var original = bindings.findById(plan.bindingId());
            verifyPlan(plan, original);
            if (released) {
                require(original.getState() == RuntimeBindingRecord.State.RELEASED);
                receipt(saved, original);
            } else {
                require(original.getState() == RuntimeBindingRecord.State.DRAINING);
                verifyOriginal(selected, original, false);
                if ("PLATFORM_CLEANED".equals(saved.get("state"))) {
                    receipt(saved, original);
                }
            }
            return status(request, plan);
        });
    }

    public Status begin(Request request) {
        Status prior = inspect(request);
        if (!"NOT_STARTED".equals(prior.state())) {
            return prior;
        }
        var selected = selected(request);
        var original = bindings.findActive(runtimeRequest(selected));
        require(original != null);
        if (original.getState() != RuntimeBindingRecord.State.READY || original.isDrainRequested()) {
            Status raced = inspect(request);
            require(!"NOT_STARTED".equals(raced.state()));
            return raced;
        }
        String owner = "resident-retirement:" + UUID.randomUUID();
        var claimed = bindings.claimOperation(original.getBindingId(), owner, Duration.ofSeconds(30));
        if (claimed == null) {
            Status raced = inspect(request);
            require(!"NOT_STARTED".equals(raced.state()));
            return raced;
        }
        try {
            return transaction.execute(status -> {
                authorize(request, true);
                var operations = operations(request);
                var saved = operations.find(WORKSPACE_RETIREMENT, request.retirementId(), true);
                if (saved != null) {
                    var plan = plan(request, selected, saved);
                    verifyPlan(plan, bindings.findById(plan.bindingId()));
                    return status(request, plan);
                }
                require(jdbc.queryForObject("SELECT state FROM ma_workspace WHERE tenant_id = ? AND workspace_id = ?",
                        String.class, request.tenantId(), request.workspaceId()).equals("ACTIVE"));
                var locked = jdbc.execute((ConnectionCallback<RuntimeBindingRecord>) connection ->
                        bindings.lockActiveForRetirement(connection, claimed));
                require(owner.equals(locked.getOperationOwner()) && claimed.getOperationGeneration() == locked.getOperationGeneration()
                        && locked.getState() == RuntimeBindingRecord.State.READY && !locked.isDrainRequested());
                verifyOriginal(selected, locked, true);
                idle(request);
                require(jdbc.queryForList("SELECT operation_key FROM ma_operation WHERE operation_kind = 'WORKSPACE_RETIREMENT'"
                        + " AND target_key = ? AND target_revision = ? FOR UPDATE", String.class,
                        WorkspaceOperations.hash(locked.getBindingId()), locked.getGeneration()).isEmpty());
                Plan plan = new Plan(2, request, locked.getBindingId(), locked.getGeneration(),
                        (String) locked.getResourceHandle().getValue().get("identity"), digest(selected), new com.alibaba.qwen.code.managedagent.contracts.workspace.ResidentWorkspaceSnapshot(selected.workspaceId(), selected.workspaceGeneration(), selected.registration(), selected.protection(), selected.image(), selected.command(), selected.artifacts()));
                String encoded = encode(plan);
                require(encoded.getBytes(StandardCharsets.UTF_8).length <= PLAN_LIMIT);
                operations.create(WORKSPACE_RETIREMENT, request.retirementId(), WorkspaceOperations.values(
                        "binding_id", locked.getBindingId(), "runtime_generation", locked.getGeneration(),
                        "storage_id", selected.registration().storageId(), "physical_key", selected.registration().physicalKey(),
                        "state", "DRAINING", "request_json", encoded, "request_digest", digest(plan)));
                require(jdbc.update("UPDATE ma_workspace SET state = 'DRAINING' WHERE tenant_id = ? AND workspace_id = ?"
                        + " AND workspace_generation = ? AND state = 'ACTIVE'", request.tenantId(), request.workspaceId(),
                        request.workspaceGeneration()) == 1);
                jdbc.execute((ConnectionCallback<Void>) connection -> {
                    bindings.sealForRetirement(connection, locked);
                    return null;
                });
                return status(request, plan);
            });
        } finally {
            bindings.releaseOperation(claimed.getBindingId(), owner, claimed.getOperationGeneration());
        }
    }

    public ResidentReclamation.Baseline baseline(Map<String, Object> saved) {
        require(saved.get("reclamationBaseline") != null);
        var baseline = json.convertValue(saved.get("reclamationBaseline"), ResidentReclamation.Baseline.class);
        require(baseline != null && digest(baseline).equals(saved.get("reclamationBaselineDigest")));
        return baseline;
    }

    public ResidentReclamation.Receipt receipt(Map<String, Object> saved, RuntimeBindingRecord original) {
        require(saved.get("cleanupReceipt") != null);
        var receipt = json.convertValue(saved.get("cleanupReceipt"), ResidentReclamation.Receipt.class);
        require(receipt != null && digest(receipt).equals(saved.get("cleanupReceiptDigest")));
        ResidentReclamation.verifyReceipt(original, baseline(saved), receipt);
        return receipt;
    }

    private ResidentWorkspace authorize(Request request, boolean lock) {
        return authorize(request, selected(request), lock);
    }

    private ResidentWorkspace authorize(Request request, ResidentWorkspace selected, boolean lock) {
        if (lock) {
            WorkspaceMigrationAdmission.lockTenant(jdbc, request.tenantId(), 10);
            ToolPublicationRetentionStore.lockTenant(jdbc, request.tenantId(), 10);
        }
        var rows = jdbc.queryForList("SELECT state FROM ma_workspace WHERE tenant_id = ? AND workspace_id = ?"
                + " AND workspace_generation = ? AND storage_id = ? AND config_ref = ? AND policy_ref = ?"
                + (lock ? " FOR UPDATE" : ""), String.class, request.tenantId(), request.workspaceId(), request.workspaceGeneration(),
                selected.registration().storageId(), com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile.CONFIG_REF,
                com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile.POLICY_REF);
        require(rows.size() == 1 && List.of("ACTIVE", "DRAINING").contains(rows.getFirst()));
        require(jdbc.queryForList("SELECT role FROM ma_workspace_access WHERE tenant_id = ? AND workspace_id = ?"
                + " AND actor_id = ?" + (lock ? " FOR UPDATE" : ""), String.class, request.tenantId(), request.workspaceId(),
                com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry.actorKey(request.tenantId(), request.actorId())).equals(List.of("OWNER")));
        return selected;
    }

    public ResidentWorkspace selected(Request request) {
        return mappings.stream().filter(value -> value.registration().tenantId().equals(request.tenantId())
                && value.workspaceId().equals(request.workspaceId()) && value.workspaceGeneration() == request.workspaceGeneration())
                .findFirst().orElseThrow(ResidentWorkspaceRetirementStore::unavailable);
    }

    private void idle(Request request) {
        require(jdbc.queryForList("SELECT session_id FROM ma_session WHERE tenant_id = ? AND workspace_id = ?"
                + " AND session_kind = 'PUBLIC' AND status NOT IN ('CLOSED', 'ARCHIVED', 'DELETED') LIMIT 1 FOR UPDATE",
                String.class, request.tenantId(), request.workspaceId()).isEmpty());
        require(jdbc.queryForList("SELECT session_id FROM ma_session_head WHERE tenant_id = ? AND workspace_id = ?"
                + " AND head_kind = 'MANAGED_SESSION' AND (state IS NULL OR state NOT IN ('SEALED', 'DELETED')"
                + " OR writer_lease_until > " + ManagedSchemaTime.SQL_NOW
                + " OR state = 'DELETED' AND (writer_id IS NOT NULL OR writer_lease_until IS NOT NULL)) LIMIT 1 FOR UPDATE",
                String.class, request.tenantId(), request.workspaceId()).isEmpty());
        require(jdbc.queryForList("SELECT rs.runtime_session_id FROM ma_runtime_session rs JOIN ma_runtime_binding b"
                + " ON b.binding_id = rs.binding_id WHERE b.tenant_id = ? AND b.workspace_id = ?"
                + " AND rs.session_state <> 'RELEASED' LIMIT 1 FOR UPDATE", String.class,
                request.tenantId(), request.workspaceId()).isEmpty());
        require(jdbc.queryForList("SELECT e.execution_call_id FROM ma_tool_execution e JOIN ma_runtime_binding b"
                + " ON b.binding_id = e.binding_id WHERE b.tenant_id = ? AND b.workspace_id = ?"
                + " AND e.execution_state <> 'SETTLED' LIMIT 1 FOR UPDATE", String.class,
                request.tenantId(), request.workspaceId()).isEmpty());
    }

    private RuntimeBindingRecord lockedPlan(Request request, ResidentWorkspace selected, boolean checkOwner) {
        if (checkOwner) {
            authorize(request, true);
        } else {
            WorkspaceMigrationAdmission.lockTenant(jdbc, request.tenantId(), 10);
        }
        var saved = operations(request).find(WORKSPACE_RETIREMENT, request.retirementId(), false);
        require(saved != null);
        var plan = plan(request, selected, saved);
        var hint = bindings.findById(plan.bindingId());
        require(hint != null);
        var original = jdbc.execute((ConnectionCallback<RuntimeBindingRecord>) connection ->
                bindings.lockActiveForRetirement(connection, hint));
        verifyPlan(plan, original);
        require(original.getState() == RuntimeBindingRecord.State.DRAINING);
        verifyOriginal(selected, original, true);
        plan(request, selected, operations(request).find(WORKSPACE_RETIREMENT, request.retirementId(), true));
        require(jdbc.queryForObject("SELECT state FROM ma_workspace WHERE tenant_id = ? AND workspace_id = ?",
                String.class, request.tenantId(), request.workspaceId()).equals("DRAINING"));
        return original;
    }

    private void verifyOriginal(ResidentWorkspace selected, RuntimeBindingRecord original, boolean lock) {
        WorkspaceCsiRuntimeIdentity.verify(original);
        require(original.getRequest().equals(runtimeRequest(selected)));
        require(jdbc.queryForList("SELECT active_binding_id FROM ma_runtime_slot WHERE request_key = ?"
                + " AND last_generation = ?" + (lock ? " FOR UPDATE" : ""), String.class,
                original.getRequest().requestKey(), original.getGeneration()).equals(List.of(original.getBindingId())));
        if (lock) {
            require(jdbc.queryForList("SELECT alias_key FROM ma_storage WHERE alias_key = ? FOR UPDATE", String.class,
                    selected.registration().aliasKey()).equals(List.of(selected.registration().aliasKey())));
        }
        ResidentWorkspaces.requireRegistration(jdbc, selected);
        var registration = selected.registration();
        var storage = map(original.getResourceHandle().getValue().get("storage"));
        var expected = new LinkedHashMap<String, Object>(Map.of("clusterDomain", registration.clusterDomain(), "namespace", registration.namespace(),
                "pvcUid", registration.pvcUid(), "pvUid", registration.pvUid(), "driver", registration.driver(),
                "volumeHandle", registration.volumeHandle(), "backendDomain", registration.backendDomain(),
                "diskSerial", registration.diskSerial(), "physicalKey", registration.physicalKey()));
        require(storage.get("reservationRevision") instanceof String revision && revision.matches("[1-9][0-9]{0,18}")
                && CsiOwnershipRevision.residentReserved(Long.parseLong(revision)));
        expected.putAll(Map.of("registrationRevision", Long.toString(registration.revision()),
                "reservationId", storage.get("reservationId"), "reservationRevision", storage.get("reservationRevision")));
        require(same(expected, storage));
        var protection = selected.protection();
        require(same(Map.of("namespaceUid", protection.namespaceUid(), "policyName", protection.policyName(), "policyUid", protection.policyUid(),
                "policyGeneration", Long.toString(protection.policyGeneration()), "bindingName", protection.bindingName(),
                "bindingUid", protection.bindingUid(), "bindingGeneration", Long.toString(protection.bindingGeneration())),
                original.getResourceHandle().getValue().get("protection")));
        require(jdbc.queryForList("SELECT binding_id FROM ma_storage_owner WHERE storage_key = ? AND storage_kind = 'CSI'"
                + " AND csi_phase = 'RESERVED' AND binding_id = ? AND runtime_generation = ? AND csi_registration_key = ?"
                + " AND csi_registration_revision = ? AND csi_reservation_id = ? AND csi_revision = ?"
                + " AND csi_provision_request_id = ? AND holder_key IS NULL AND runtime_session_id IS NULL"
                + (lock ? " FOR UPDATE" : ""), String.class, registration.physicalKey(), original.getBindingId(), original.getGeneration(),
                registration.aliasKey(), registration.revision(), storage.get("reservationId"), Long.parseLong((String) storage.get("reservationRevision")),
                original.getProvisionSeed().getProvisionRequestId()).equals(List.of(original.getBindingId())));
    }

    private Plan plan(Request request, ResidentWorkspace selected, Map<String, Object> saved) {
        Plan plan = readPlan(request, saved);
        require(digest(selected).equals(plan.mappingDigest()) && !"RELEASED".equals(saved.get("state")));
        return plan;
    }

    private Plan readPlan(Request request, Map<String, Object> saved) {
        try {
            String encoded = (String) saved.get("request_json");
            require(encoded != null && encoded.getBytes(StandardCharsets.UTF_8).length <= PLAN_LIMIT);
            Plan plan = json.readValue(encoded, Plan.class);
            require(request.equals(plan.request()) && digest(plan).equals(saved.get("request_digest"))
                    && List.of("DRAINING", "PLATFORM_CLEANED", "RELEASED").contains(saved.get("state"))
                    && (plan.version() == 1 && plan.mapping() == null && "DRAINING".equals(saved.get("state"))
                            || plan.version() == 2 && plan.mapping() != null
                                    && digest(plan.mapping()).equals(plan.mappingDigest())
                                    && request.tenantId().equals(plan.mapping().registration().tenantId())
                                    && request.workspaceId().equals(plan.mapping().workspaceId())
                                    && request.workspaceGeneration() == plan.mapping().workspaceGeneration()));
            return plan;
        } catch (java.io.IOException failure) {
            throw unavailable();
        }
    }

    private static void verifyPlan(Plan plan, RuntimeBindingRecord original) {
        require(original != null && original.getGeneration() == plan.runtimeGeneration()
                && List.of(RuntimeBindingRecord.State.DRAINING, RuntimeBindingRecord.State.RELEASED).contains(original.getState())
                && original.isDrainRequested()
                && original.getResourceHandle() != null && Objects.equals(plan.resourceIdentity(), original.getResourceHandle().getValue().get("identity")));
        WorkspaceCsiRuntimeIdentity.verify(original);
        require(plan.mapping() == null || original.getRequest().equals(runtimeRequest(plan.mapping())));
    }

    private List<Map<String, Object>> attempts(Request request) {
        return jdbc.query("SELECT * FROM ma_operation_work WHERE operation_key = ? AND work_kind = ? ORDER BY target_key LIMIT 9",
                (row, index) -> WorkspaceOperations.work(row), operationKey(request), WORK);
    }

    private List<Map<String, Object>> finalizerAttempts(Request request) {
        return jdbc.query("SELECT * FROM ma_operation_work WHERE operation_key = ? AND work_kind = ? ORDER BY target_key LIMIT 17",
                (row, index) -> WorkspaceOperations.work(row), operationKey(request), FINALIZER_WORK);
    }

    private Status status(Request request, Plan plan) {
        var attempts = attempts(request);
        var metadata = finalizerAttempts(request);
        var saved = operations(request).find(WORKSPACE_RETIREMENT, request.retirementId(), false);
        require(attempts.size() <= 8 && metadata.size() <= 16);
        return new Status(request.retirementId(), (String) saved.get("state"), plan.bindingId(), plan.runtimeGeneration(), attempts.stream()
                .map(value -> new AttemptStatus(((Number) value.get("ordinal")).intValue(), (String) value.get("resourceVersion"),
                        (String) value.get("state"), value.get("httpStatus") instanceof Number code ? code.intValue() : null,
                        (String) value.get("responseSha256"))).sorted(java.util.Comparator.comparingInt(AttemptStatus::ordinal)).toList(),
                metadata.stream().map(value -> new FinalizerAttemptStatus(((Number) value.get("ordinal")).intValue(),
                        (String) value.get("action"), (String) value.get("resourceVersion"), (String) value.get("state"),
                        value.get("httpStatus") instanceof Number code ? code.intValue() : null, (String) value.get("responseSha256")))
                        .sorted(java.util.Comparator.comparingInt(FinalizerAttemptStatus::ordinal)).toList(),
                saved.get("cleanupReceiptDigest") instanceof String sha ? new Completion(sha, ResidentReclamation.DATA_POLICY,
                        saved.get("releasedRevision") instanceof Number revision ? revision.longValue() : null) : null);
    }

    private WorkspaceOperations operations(Request request) { return new WorkspaceOperations(jdbc, request.tenantId()); }
    private static String operationKey(Request request) { return WorkspaceOperations.key(WORKSPACE_RETIREMENT, request.tenantId(), request.retirementId()); }
    private static RuntimeProvisionRequest runtimeRequest(ResidentWorkspace selected) {
        return new RuntimeProvisionRequest(ResidentWorkspaces.scope(selected), null, WorkspaceCsiReservationStore.PROVISIONER_KIND, selected.registration().storageId());
    }
    private static boolean empty(Object value) { return value == null || value instanceof List<?> list && list.isEmpty(); }
    private String encode(Object value) {
        try {
            return json.writeValueAsString(value);
        } catch (java.io.IOException failure) {
            throw unavailable();
        }
    }
    private static void require(boolean valid) {
        if (!valid) {
            throw unavailable();
        }
    }
    private static RuntimeBrokerException unavailable() {
        return new RuntimeBrokerException(409, "resident_retirement_unavailable", "Original idle Workspace maintenance is unavailable.", false);
    }

    public void completeDeletion(Request request, ResidentWorkspace selected, Attempt attempt, KubernetesMaintenanceClient.DeleteResponse response) {
        transaction.executeWithoutResult(status -> {
            lockedPlan(request, selected, false);
            require(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE operation_key = ? AND claim_owner = ?"
                    + " AND claim_generation = ? AND claim_until > " + ManagedSchemaTime.SQL_NOW,
                    Long.class, operationKey(request), attempt.owner(), attempt.generation()) == 1);
            if (response != null) {
                require(response.body().length <= 64 * 1024);
                operations(request).updateWork(WORKSPACE_RETIREMENT, request.retirementId(), WORK, attempt.workKey(),
                        WorkspaceOperations.values("state", response.complete() ? "RETURNED" : "UNKNOWN", "httpStatus", response.status(),
                                "responseBase64", Base64.getEncoder().encodeToString(response.body()),
                                "responseSha256", org.apache.commons.codec.digest.DigestUtils.sha256Hex(response.body()),
                                "complete", response.complete()));
            }
            jdbc.update("UPDATE ma_operation SET claim_owner = NULL, claim_until = NULL WHERE operation_key = ?"
                    + " AND claim_owner = ? AND claim_generation = ?", operationKey(request), attempt.owner(), attempt.generation());
        });
    }

    public Attempt beginDeletion(Request request, ResidentWorkspace selected, String workKey, String resourceVersion, byte[] body) {
        return transaction.execute(status -> {
            lockedPlan(request, selected, true);
            idle(request);
            var operations = operations(request);
            if (operations.findWork(WORKSPACE_RETIREMENT, request.retirementId(), WORK, workKey, true) != null) {
                return null;
            }
            int count = attempts(request).size();
            require(count < 8);
            String owner = UUID.randomUUID().toString();
            require(jdbc.update("UPDATE ma_operation SET claim_owner = ?, claim_generation = claim_generation + 1,"
                    + " claim_until = " + ManagedSchemaTime.SQL_NOW + " + 60000 WHERE operation_key = ?"
                    + " AND (claim_until IS NULL OR claim_until <= " + ManagedSchemaTime.SQL_NOW + ")",
                    owner, operationKey(request)) == 1);
            long generation = jdbc.queryForObject("SELECT claim_generation FROM ma_operation WHERE operation_key = ?",
                    Long.class, operationKey(request));
            operations.insertWork(WORKSPACE_RETIREMENT, request.retirementId(), WORK, workKey, workKey, null,
                    WorkspaceOperations.values("ordinal", count + 1, "resourceVersion", resourceVersion,
                            "requestBase64", Base64.getEncoder().encodeToString(body), "claimGeneration", generation), "UNKNOWN");
            return new Attempt(workKey, owner, generation, body);
        });
    }

    public void recordBaseline(Request request, ResidentWorkspace selected, ResidentReclamation.Baseline observed, String finalizer) {
        transaction.executeWithoutResult(status -> {
            lockedPlan(request, selected, true);
            idle(request);
            var current = operations(request).find(WORKSPACE_RETIREMENT, request.retirementId(), true);
            require("DRAINING".equals(current.get("state")));
            if (current.get("reclamationBaseline") == null) {
                operations(request).update(WORKSPACE_RETIREMENT, request.retirementId(), WorkspaceOperations.values(
                        "reclamationBaseline", json.valueToTree(observed), "reclamationBaselineDigest", digest(observed)));
            } else {
                var first = baseline(current);
                require(first.finalizer().equals(finalizer) && first.bootId().equals(observed.bootId())
                        && first.leaseUid().equals(observed.leaseUid()) && first.attachmentUid().equals(observed.attachmentUid()));
            }
        });
    }

    public Status release(Request request, ResidentWorkspace selected, ResidentReclamation.Receipt proof) {
        return transaction.execute(status -> {
            var current = operations(request).find(WORKSPACE_RETIREMENT, request.retirementId(), false);
            if ("RELEASED".equals(current.get("state"))) {
                return inspect(request);
            }
            var locked = lockedPlan(request, selected, true);
            idle(request);
            current = operations(request).find(WORKSPACE_RETIREMENT, request.retirementId(), true);
            require("PLATFORM_CLEANED".equals(current.get("state")) && digest(proof).equals(current.get("cleanupReceiptDigest")));
            receipt(current, locked);
            require(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE operation_key = ?"
                    + " AND (claim_until IS NULL OR claim_until <= " + ManagedSchemaTime.SQL_NOW + ")", Long.class, operationKey(request)) == 1);
            var storage = map(locked.getResourceHandle().getValue().get("storage"));
            long revision = Math.addExact(Long.parseLong((String) storage.get("reservationRevision")), 1);
            jdbc.execute((ConnectionCallback<Void>) connection -> {
                bindings.releaseResidentForRetirement(connection, locked);
                return null;
            });
            require(jdbc.update("UPDATE ma_storage_owner SET csi_phase = 'RELEASED', csi_revision = ?, tenant_id = ?,"
                    + " binding_id = NULL, runtime_generation = NULL, csi_reservation_id = NULL, csi_registration_key = NULL,"
                    + " csi_registration_revision = NULL, csi_provision_request_id = NULL"
                    + " WHERE storage_key = ? AND storage_kind = 'CSI' AND csi_phase = 'RESERVED' AND csi_revision = ?"
                    + " AND binding_id = ? AND runtime_generation = ? AND csi_reservation_id = ?"
                    + " AND (tenant_id IS NULL OR tenant_id = ?)", revision, request.tenantId(), selected.registration().physicalKey(),
                    revision - 1, locked.getBindingId(), locked.getGeneration(), storage.get("reservationId"), request.tenantId()) == 1);
            operations(request).update(WORKSPACE_RETIREMENT, request.retirementId(), WorkspaceOperations.values(
                    "state", "RELEASED", "releasedRevision", revision));
            require(jdbc.update("UPDATE ma_operation SET claim_owner = NULL, claim_until = NULL, claim_generation = claim_generation + 1"
                    + " WHERE operation_key = ?", operationKey(request)) == 1);
            return status(request, readPlan(request, operations(request).find(WORKSPACE_RETIREMENT, request.retirementId(), false)));
        });
    }

    public void recordCleanup(Request request, ResidentWorkspace selected, ResidentReclamation.Baseline baseline, ResidentReclamation.Receipt observed, RuntimeBindingRecord original) {
        transaction.executeWithoutResult(
                status -> {
                    lockedPlan(request, selected, true);
                    idle(request);
                    var current =
                            operations(request)
                                    .find(WORKSPACE_RETIREMENT, request.retirementId(), true);
                    if ("DRAINING".equals(current.get("state"))) {
                        require(digest(baseline).equals(current.get("reclamationBaselineDigest")));
                        operations(request)
                                .update(
                                        WORKSPACE_RETIREMENT,
                                        request.retirementId(),
                                        WorkspaceOperations.values(
                                                "state",
                                                "PLATFORM_CLEANED",
                                                "cleanupReceipt",
                                                json.valueToTree(observed),
                                                "cleanupReceiptDigest",
                                                digest(observed)));
                    } else {
                        receipt(current, original);
                    }
                });
    }

    public void completeFinalizer(Request request, ResidentWorkspace selected, Attempt attempt, KubernetesMaintenanceClient.DeleteResponse reply) {
        transaction.executeWithoutResult(status -> {
            lockedPlan(request, selected, false);
            require(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE operation_key = ? AND claim_owner = ?"
                    + " AND claim_generation = ? AND claim_until > " + ManagedSchemaTime.SQL_NOW, Long.class,
                    operationKey(request), attempt.owner(), attempt.generation()) == 1);
            if (reply != null) {
                require(reply.body().length <= 64 * 1024);
                operations(request).updateWork(WORKSPACE_RETIREMENT, request.retirementId(), FINALIZER_WORK, attempt.workKey(),
                        WorkspaceOperations.values("state", reply.complete() ? "RETURNED" : "UNKNOWN", "httpStatus", reply.status(),
                                "responseSha256", org.apache.commons.codec.digest.DigestUtils.sha256Hex(reply.body()), "complete", reply.complete()));
            }
            jdbc.update("UPDATE ma_operation SET claim_owner = NULL, claim_until = NULL WHERE operation_key = ?"
                    + " AND claim_owner = ? AND claim_generation = ?", operationKey(request), attempt.owner(), attempt.generation());
        });
    }

    public Attempt beginFinalizer(Request request, ResidentWorkspace selected, RuntimeBindingRecord original, String finalizer, String action, Map<String, Object> metadata, String resourceVersion, byte[] body) {
        return transaction.execute(status -> {
            lockedPlan(request, selected, true);
            idle(request);
            var saved = operations(request).find(WORKSPACE_RETIREMENT, request.retirementId(), true);
            require(baseline(saved).finalizer().equals(finalizer)
                    && ("ADD".equals(action) ? "DRAINING".equals(saved.get("state")) : "PLATFORM_CLEANED".equals(saved.get("state"))));
            if ("REMOVE".equals(action)) {
                receipt(saved, original);
            }
            var previous = finalizerAttempts(request);
            require(previous.size() < 16 && previous.stream().filter(value -> action.equals(value.get("action"))).count() < 8);
            String owner = UUID.randomUUID().toString();
            require(jdbc.update("UPDATE ma_operation SET claim_owner = ?, claim_generation = claim_generation + 1,"
                    + " claim_until = " + ManagedSchemaTime.SQL_NOW + " + 60000 WHERE operation_key = ?"
                    + " AND (claim_until IS NULL OR claim_until <= " + ManagedSchemaTime.SQL_NOW + ")", owner, operationKey(request)) == 1);
            long generation = jdbc.queryForObject("SELECT claim_generation FROM ma_operation WHERE operation_key = ?", Long.class, operationKey(request));
            String workKey = WorkspaceOperations.hash(action, (String) metadata.get("uid"), resourceVersion, Long.toString(generation));
            operations(request).insertWork(WORKSPACE_RETIREMENT, request.retirementId(), FINALIZER_WORK, workKey, workKey, null,
                    WorkspaceOperations.values("ordinal", previous.size() + 1, "action", action, "resourceVersion", resourceVersion,
                            "requestBase64", Base64.getEncoder().encodeToString(body), "claimGeneration", generation), "UNKNOWN");
            return new Attempt(workKey, owner, generation, body);
        });
    }

    public RuntimeBindingRecord original(Request request, ResidentWorkspace selected) {
        return transaction.execute(status -> lockedPlan(request, selected, true));
    }

    public Map<String, Object> loadState(Request request) {
        return operations(request).find(WORKSPACE_RETIREMENT, request.retirementId(), false);
    }

    public boolean hasDeletionAttempt(Request request, String workKey) {
        return operations(request).findWork(WORKSPACE_RETIREMENT, request.retirementId(), WORK, workKey, false) != null;
    }

    public boolean hasDeletionAttempts(Request request) { return !attempts(request).isEmpty(); }

    public int planVersion(Request request, Map<String, Object> state) { return readPlan(request, state).version(); }
}
