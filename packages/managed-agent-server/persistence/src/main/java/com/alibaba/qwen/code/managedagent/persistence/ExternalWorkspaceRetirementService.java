package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles;
import com.alibaba.qwen.code.runtimebroker.BrokerValues;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.spi.ExternalWorkspaceRecoveryGateway;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/** 首次启动失败且原实例已终止时的受控退役；保留 ACTIVE 会话，不迁移已使用过的运行时成员。 */
@Component
@ConditionalOnProperty(prefix = "qwen.managed-agent.runtime-broker",
        name = "external-terminal-retirement-enabled", havingValue = "true")
public final class ExternalWorkspaceRetirementService {
    private static final WorkspaceOperations.Kind KIND = WorkspaceOperations.Kind.WORKSPACE_RETIREMENT;
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaction;
    private final JdbcRuntimeBindingRepository bindings;
    private final ExternalStorageRegistrationStore storage;
    private final ManagedWorkspaceRegistry registry;
    private final ExternalWorkspaceRecoveryGateway broker;
    private final ObjectMapper json;

    public record Request(String tenantId, String ownerUserId, String workspaceId, long workspaceGeneration,
            String bindingId, long runtimeGeneration, long expectedVersion, String retirementId) {
        public Request {
            for (String value : List.of(tenantId, ownerUserId, workspaceId, bindingId, retirementId)) {
                BrokerValues.requireId(value, "retirement identity");
            }
            if (workspaceGeneration <= 0 || runtimeGeneration <= 0 || expectedVersion < 0) {
                throw new IllegalArgumentException("Invalid retirement generation");
            }
        }
    }
    public record Identity(String tenantId, String workspaceId, long workspaceGeneration, String bindingId,
            long runtimeGeneration, String providerId, String provisionRequestId, String handleIdentity) { }
    public record TerminationProof(Identity identity, String sandboxId, String state, Instant observedAt,
            String auditId, String evidenceSha256) { }
    @FunctionalInterface
    public interface TerminationVerifier {
        /** 可信宿主须从原分配回执核对身份并重新 GET 同一实例；禁止采纳用户自报状态或创建/删除实例。 */
        TerminationProof verify(Identity identity);
    }
    public record Receipt(String retirementId, Identity identity, String state, long fencedVersion,
            String proofDigest, String sandboxId, String auditId, Instant observedAt, String evidenceSha256,
            boolean resumed) { }
    private record Plan(int version, Request request, Identity identity) { }

    public ExternalWorkspaceRetirementService(@Qualifier("managedJdbcTemplate") JdbcTemplate jdbc,
            @Qualifier("managedAgentTransactionManager") PlatformTransactionManager manager,
            RuntimeBindingRepository bindings, ExternalStorageRegistrationStore storage,
            ManagedWorkspaceRegistry registry,
            ExternalWorkspaceRecoveryGateway broker,
            @Qualifier("managedAgentObjectMapper") ObjectMapper json) {
        if (!(bindings instanceof JdbcRuntimeBindingRepository original) || !original.usesDataSource(jdbc.getDataSource())) {
            throw new IllegalArgumentException("Original native JDBC repositories are required");
        }
        this.jdbc = jdbc;
        this.transaction = new TransactionTemplate(manager);
        this.transaction.setTimeout(10);
        this.bindings = original;
        this.storage = storage;
        this.registry = registry;
        this.broker = broker;
        this.json = json;
    }

    public Receipt inspect(Request request) {
        requireOwner(request);
        var saved = operations(request).find(KIND, request.retirementId(), false);
        return saved == null ? null : receipt(request, saved);
    }

    public Receipt retire(Request request, TerminationVerifier verifier) {
        Receipt prior = inspect(request);
        if (prior != null) { return prior; }
        RuntimeBindingRecord original = original(request);
        Identity identity = identity(request, original);
        TerminationProof proof = Objects.requireNonNull(verifier, "Trusted termination verifier").verify(identity);
        verifyProof(identity, proof);
        return transaction.execute(status -> {
            lock(request);
            var operations = operations(request);
            var saved = operations.find(KIND, request.retirementId(), true);
            if (saved != null) { return receipt(request, saved); }
            requireWorkspace(request, "ACTIVE");
            RuntimeBindingRecord current = jdbc.execute((ConnectionCallback<RuntimeBindingRecord>) connection ->
                    bindings.lockActiveForRetirement(connection, original));
            require(current != null && current.getVersion() == request.expectedVersion());
            requireOriginal(request, current);
            require(identity.equals(identity(request, current)));
            verifyProof(identity, proof);
            // placement、Workspace、Session/head 和 binding 的原生锁覆盖整个检查与提交，不留新准入空窗。
            requireIdle(request, current);
            require(jdbc.update("UPDATE ma_workspace SET state = 'DRAINING' WHERE tenant_id = ? AND workspace_id = ?"
                    + " AND workspace_generation = ? AND state = 'ACTIVE'", request.tenantId(), request.workspaceId(),
                    request.workspaceGeneration()) == 1);
            RuntimeBindingRecord released = jdbc.execute((ConnectionCallback<RuntimeBindingRecord>) connection ->
                    bindings.retireUnacquiredExternal(connection, current));
            String digest = proofDigest(request, proof);
            operations.create(KIND, request.retirementId(), WorkspaceOperations.values(
                    "state", "DRAINING", "binding_id", current.getBindingId(),
                    "runtime_generation", current.getGeneration(), "storage_id", current.getRequest().getStorageId(),
                    "request_json", encode(new Plan(1, request, identity)), "proof_json", encode(proof),
                    "proof_digest", digest, "fenced_version", released.getVersion(), "resumed", false));
            operations.update(KIND, request.retirementId(), WorkspaceOperations.values("state", "PLATFORM_CLEANED"));
            operations.update(KIND, request.retirementId(), WorkspaceOperations.values("state", "RELEASED"));
            return receipt(request, operations.find(KIND, request.retirementId(), true));
        });
    }

    /** 宿主原 receipt 的 RETIRED CAS 成功后才调用；不重放旧 turn，也不创建下一代 Worker。 */
    public Receipt resume(Request request, String proofDigest) {
        return transaction.execute(status -> {
            lock(request);
            var operations = operations(request);
            var saved = operations.find(KIND, request.retirementId(), true);
            require(saved != null);
            Receipt receipt = receipt(request, saved);
            require(receipt.proofDigest().equals(proofDigest));
            if (receipt.resumed()) { return receipt; }
            requireWorkspace(request, "DRAINING");
            RuntimeBindingRecord original = bindings.findById(request.bindingId());
            require(original != null && original.getState() == RuntimeBindingRecord.State.RELEASED
                    && original.getGeneration() == request.runtimeGeneration()
                    && original.getVersion() == receipt.fencedVersion());
            requireNoOtherBinding(request, null);
            require(jdbc.update("UPDATE ma_workspace SET state = 'ACTIVE' WHERE tenant_id = ? AND workspace_id = ?"
                    + " AND workspace_generation = ? AND state = 'DRAINING'", request.tenantId(), request.workspaceId(),
                    request.workspaceGeneration()) == 1);
            operations.update(KIND, request.retirementId(), WorkspaceOperations.values("resumed", true));
            return receipt(request, operations.find(KIND, request.retirementId(), true));
        });
    }

    private void lock(Request request) {
        WorkspaceMigrationAdmission.lockTenant(jdbc, request.tenantId(), 10);
        ToolPublicationRetentionStore.lockTenant(jdbc, request.tenantId(), 10);
        WorkspaceLifecycleStore.lockPlacement(jdbc, request.tenantId(), 10);
        require(jdbc.queryForList("SELECT role FROM ma_workspace_access WHERE tenant_id = ? AND workspace_id = ?"
                + " AND actor_id = ? FOR UPDATE", String.class, request.tenantId(), request.workspaceId(),
                com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry.actorKey(
                        request.tenantId(), request.ownerUserId()))
                .equals(List.of("OWNER")));
    }

    private void requireOwner(Request request) {
        require(registry.accessOf(request.tenantId(), request.ownerUserId(), request.workspaceId())
                == com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceAccess.OWNER);
    }

    private void requireWorkspace(Request request, String state) {
        require(jdbc.queryForList("SELECT state FROM ma_workspace WHERE tenant_id = ? AND workspace_id = ?"
                + " AND workspace_generation = ? AND storage_id = ? FOR UPDATE", String.class,
                request.tenantId(), request.workspaceId(), request.workspaceGeneration(), request.workspaceId())
                .equals(List.of(state)));
    }

    private RuntimeBindingRecord original(Request request) {
        RuntimeBindingRecord binding = bindings.findById(request.bindingId());
        requireOriginal(request, binding);
        require(binding.getVersion() == request.expectedVersion());
        return binding;
    }

    private void requireOriginal(Request request, RuntimeBindingRecord binding) {
        require(binding != null
                && WorkspaceExecutionProfile.isExternalWorkspaceRequest(
                        binding.getRequest()));
        var scope = binding.getRequest().getScope();
        require("workspace".equals(scope.getIsolationClass()) && request.tenantId().equals(scope.getTenantId())
                && request.workspaceId().equals(scope.getWorkspaceId())
                && Long.toString(request.workspaceGeneration()).equals(scope.getWorkspaceGeneration())
                && request.runtimeGeneration() == binding.getGeneration() && binding.getLease() == null
                && binding.getAttestationGeneration() == 0 && !binding.isDrainRequested()
                && (binding.getState() == RuntimeBindingRecord.State.PROVISIONING
                        || binding.getState() == RuntimeBindingRecord.State.RECOVERY_BLOCKED
                        || binding.getState() == RuntimeBindingRecord.State.READY));
        broker.validateExternalTerminalOriginal(binding);
        var registered = storage.find(request.tenantId(), request.workspaceId()).orElseThrow(ExternalWorkspaceRetirementService::blocked);
        require(registered.ephemeral() && request.tenantId().equals(registered.ephemeralTenantId()));
    }

    private Identity identity(Request request, RuntimeBindingRecord binding) {
        return new Identity(request.tenantId(), request.workspaceId(), request.workspaceGeneration(),
                request.bindingId(), request.runtimeGeneration(), (String) binding.getResourceHandle().getValue().get("providerId"),
                binding.getProvisionSeed().getProvisionRequestId(), (String) binding.getResourceHandle().getValue().get("identity"));
    }

    private void requireIdle(Request request, RuntimeBindingRecord binding) {
        requireNoOtherBinding(request, request.bindingId());
        var members = jdbc.query("SELECT session_id, session_kind, status, tool_profile, workspace_generation,"
                + " workspace_storage_id FROM ma_session WHERE tenant_id = ? AND workspace_id = ? ORDER BY session_id FOR UPDATE",
                (row, index) -> com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows.read(row),
                request.tenantId(), request.workspaceId());
        for (var member : members) {
            require("PUBLIC".equals(member.get("session_kind"))
                    && List.of("ACTIVE", "CLOSED", "ARCHIVED", "DELETED").contains(member.get("status"))
                    && List.of("none", WorkspaceToolProfiles.FILES, WorkspaceToolProfiles.EXTERNAL_FILES).contains(member.get("tool_profile"))
                    && member.get("workspace_generation") instanceof Number generation
                    && generation.longValue() == request.workspaceGeneration()
                    && request.workspaceId().equals(member.get("workspace_storage_id")));
            String session = (String) member.get("session_id");
            var heads = WorkspaceOperations.rows(jdbc, "SELECT phase, operation_id, recovery_status, state FROM ma_session_head"
                    + " WHERE tenant_id = ? AND session_id = ? FOR UPDATE", request.tenantId(), session);
            for (var head : heads) {
                require("OPEN".equals(head.get("phase")) && head.get("operation_id") == null
                        && (head.get("recovery_status") == null || "READY".equals(head.get("recovery_status")))
                        && (head.get("state") == null || List.of("ACTIVE", "SEALED", "DELETED").contains(head.get("state"))));
            }
            WorkspaceLifecycleStore.requireIdleJournal(jdbc, json, request.tenantId(), session);
            empty("SELECT turn_id FROM ma_turn WHERE tenant_id = ? AND session_id = ?"
                    + " AND status NOT IN ('COMPLETED','FAILED','CANCELLED') LIMIT 1 FOR UPDATE", request.tenantId(), session);
            // decided 仍可能持有 continuation；首版只接受没有审批或已明确失效/取消的审批。
            empty("SELECT record_id FROM ma_session_record WHERE tenant_id = ? AND session_id = ? AND record_kind = 'ACTION'"
                    + " AND (state IS NULL OR state NOT IN ('expired','cancelled')) LIMIT 1 FOR UPDATE", request.tenantId(), session);
            empty("SELECT operation_id FROM ma_operation WHERE tenant_id = ? AND session_id = ?"
                    + " AND (state NOT IN ('COMPLETED','FAILED','CANCELLED') OR (delivery_state IS NOT NULL AND delivery_state NOT IN ('COMPLETED','CONFIRMED'))) LIMIT 1 FOR UPDATE",
                    request.tenantId(), session);
        }
        // 孤立 head 不能当作没有成员；常规 Hosted 写入在同一 placement guard 后串行提交。
        empty("SELECT h.session_id FROM ma_session_head h LEFT JOIN ma_session s ON s.tenant_id = h.tenant_id"
                + " AND s.session_id = h.session_id AND s.workspace_id = h.workspace_id WHERE h.tenant_id = ?"
                + " AND h.workspace_id = ? AND s.session_id IS NULL LIMIT 1 FOR UPDATE", request.tenantId(), request.workspaceId());
        for (String table : List.of("ma_runtime_session", "ma_tool_execution")) {
            empty("SELECT r.binding_id FROM " + table + " r JOIN ma_runtime_binding b ON b.binding_id = r.binding_id"
                    + " WHERE b.tenant_id = ? AND b.workspace_id = ? LIMIT 1 FOR UPDATE", request.tenantId(), request.workspaceId());
        }
        var registered = storage.find(request.tenantId(), request.workspaceId()).orElseThrow(ExternalWorkspaceRetirementService::blocked);
        empty("SELECT storage_key FROM ma_storage_owner WHERE storage_key = ? AND (holder_key IS NOT NULL OR binding_id IS NOT NULL"
                + " OR runtime_generation IS NOT NULL OR runtime_session_id IS NOT NULL) LIMIT 1 FOR UPDATE", registered.ownerKey());
    }

    private void requireNoOtherBinding(Request request, String allowed) {
        var active = jdbc.queryForList("SELECT binding_id FROM ma_runtime_binding WHERE tenant_id = ? AND workspace_id = ?"
                + " AND binding_state <> 'RELEASED' FOR UPDATE", String.class, request.tenantId(), request.workspaceId());
        require(active.stream().allMatch(id -> id.equals(allowed)));
    }
    private void empty(String sql, Object... parameters) { require(WorkspaceOperations.rows(jdbc, sql, parameters).isEmpty()); }
    private WorkspaceOperations operations(Request request) { return new WorkspaceOperations(jdbc, request.tenantId()); }
    private void verifyProof(Identity identity, TerminationProof proof) {
        require(proof != null && identity.equals(proof.identity()) && "Terminated".equals(proof.state())
                && proof.observedAt() != null && !proof.observedAt().isAfter(Instant.now().plusSeconds(5))
                && Duration.between(proof.observedAt(), Instant.now()).compareTo(Duration.ofMinutes(2)) <= 0
                && proof.sandboxId() != null && proof.sandboxId().matches("[A-Za-z0-9._-]{1,128}")
                && proof.auditId() != null && proof.auditId().matches("[A-Za-z0-9._-]{1,128}")
                && proof.evidenceSha256() != null && proof.evidenceSha256().matches("[0-9a-f]{64}"));
    }
    private Receipt receipt(Request request, Map<String, Object> saved) {
        Plan plan = decode((String) saved.get("request_json"), Plan.class);
        TerminationProof proof = decode((String) saved.get("proof_json"), TerminationProof.class);
        require(plan.version() == 1 && request.equals(plan.request()) && "RELEASED".equals(saved.get("state"))
                && plan.identity().equals(proof.identity()) && "Terminated".equals(proof.state())
                && proofDigest(request, proof).equals(saved.get("proof_digest")));
        return new Receipt(request.retirementId(), plan.identity(), "RELEASED", ((Number) saved.get("fenced_version")).longValue(),
                (String) saved.get("proof_digest"), proof.sandboxId(), proof.auditId(), proof.observedAt(), proof.evidenceSha256(),
                Boolean.TRUE.equals(saved.get("resumed")));
    }
    private static String proofDigest(Request request, TerminationProof proof) {
        Identity id = proof.identity();
        return WorkspaceOperations.hash("external-unacquired-retirement/1", request.retirementId(), request.ownerUserId(),
                id.tenantId(), id.workspaceId(), Long.toString(id.workspaceGeneration()), id.bindingId(),
                Long.toString(id.runtimeGeneration()), id.providerId(), id.provisionRequestId(), id.handleIdentity(),
                proof.sandboxId(), proof.state(), proof.observedAt().toString(), proof.auditId(), proof.evidenceSha256());
    }
    private String encode(Object value) {
        try { return json.writeValueAsString(value); }
        catch (java.io.IOException error) { throw new IllegalStateException("Retirement evidence cannot be encoded", error); }
    }
    private <T> T decode(String value, Class<T> type) {
        try { return json.readValue(value, type); }
        catch (java.io.IOException | IllegalArgumentException error) { throw blocked(); }
    }
    private static void require(boolean value) { if (!value) { throw blocked(); } }
    private static RuntimeBrokerException blocked() {
        return new RuntimeBrokerException(409, "external_workspace_retirement_blocked",
                "Original Workspace termination or complete idle evidence is unavailable", false);
    }
}
