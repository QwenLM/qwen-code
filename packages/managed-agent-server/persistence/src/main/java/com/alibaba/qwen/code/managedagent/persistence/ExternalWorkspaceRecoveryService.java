package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceAccess;
import com.alibaba.qwen.code.runtimebroker.spi.ExternalWorkspaceRecoveryGateway;
import com.fasterxml.jackson.annotation.JsonIgnore;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

import javax.sql.DataSource;
import java.net.URI;
import java.sql.SQLException;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletionStage;

/** 可信宿主的原 Worker 恢复边界；不是用户 HTTP API，也不支持从 sandbox 反推丢失的数据库。 */
@Component
@ConditionalOnProperty(prefix = "qwen.managed-agent.runtime-broker",
        name = "external-recovery-enabled", havingValue = "true")
public final class ExternalWorkspaceRecoveryService {
    private final com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry workspaces;
    private final RuntimeBindingRepository bindings;
    private final ToolExecutionRepository executions;
    private final ExternalWorkspaceRecoveryGateway broker;

    public ExternalWorkspaceRecoveryService(
            com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry workspaces,
            RuntimeBindingRepository bindings, ToolExecutionRepository executions,
            ExternalWorkspaceRecoveryGateway broker,
            @Qualifier("managedAgentDataSource") DataSource dataSource) {
        this.workspaces = workspaces;
        this.bindings = bindings;
        this.executions = executions;
        this.broker = broker;
        // 原生 schema 初始化已验证整个 catalog；此入口额外拒绝易失 H2 恢复源。
        try (var connection = dataSource.getConnection()) {
            String product = connection.getMetaData().getDatabaseProductName();
            if (!"MySQL".equals(product) && !"MariaDB".equals(product)) {
                throw new IllegalStateException("External recovery requires the durable native MySQL catalog");
            }
        } catch (SQLException failure) {
            throw new IllegalStateException("Native recovery catalog is unavailable", failure);
        }
    }

    /** 每页包含该 Workspace 的所有原绑定，游标取最后一行 bindingId，不能把 eligible=false 当空页。 */
    public List<Candidate> listCandidates(String tenantId, String ownerUserId, String workspaceId,
            String afterBindingId, int limit) {
        requireOwner(tenantId, ownerUserId, workspaceId);
        return bindings.findByStorage(tenantId, workspaceId, afterBindingId, limit).stream()
                .map(binding -> candidate(binding, tenantId, workspaceId)).toList();
    }

    /** 只读。凭据只留在可信 Java 层；没有原 lease 或任何证据未决都不生成快照。 */
    public Snapshot requireSnapshot(String tenantId, String ownerUserId, String workspaceId,
            String bindingId, long expectedGeneration, long expectedVersion) {
        requireOwner(tenantId, ownerUserId, workspaceId);
        RuntimeBindingRecord binding = bindings.findById(bindingId);
        if (binding == null || binding.getGeneration() != expectedGeneration
                || binding.getVersion() != expectedVersion || !eligible(binding, tenantId, workspaceId)) {
            throw blocked();
        }
        Map<String, Object> request = broker.externalRecoveryProviderRequest(binding);
        // boot 校验期间也可能撤权或发生并发变更，返回前再核一次；仍不代替稍后的 CAS。
        requireOwner(tenantId, ownerUserId, workspaceId);
        RuntimeBindingRecord current = bindings.findById(bindingId);
        if (current == null || current.getVersion() != expectedVersion
                || current.getGeneration() != expectedGeneration) {
            throw blocked();
        }
        return new Snapshot(tenantId, ownerUserId, workspaceId, bindingId,
                expectedGeneration, expectedVersion, request, binding.getLease().getEndpoint());
    }

    /** 仅在宿主完成同一 sandbox 的只读 attestation 和原 endpoint relay 恢复后调用。 */
    public CompletionStage<Candidate> recoverSnapshot(String tenantId, String ownerUserId,
            String workspaceId, Snapshot snapshot) {
        requireOwner(tenantId, ownerUserId, workspaceId);
        if (snapshot == null || !tenantId.equals(snapshot.tenantId)
                || !ownerUserId.equals(snapshot.ownerUserId) || !workspaceId.equals(snapshot.workspaceId)) {
            throw blocked();
        }
        Snapshot current = requireSnapshot(tenantId, ownerUserId, workspaceId,
                snapshot.bindingId(), snapshot.generation(), snapshot.version());
        if (!current.originalEndpoint().equals(snapshot.originalEndpoint())
                || !current.providerRequest().equals(snapshot.providerRequest())) {
            throw blocked();
        }
        return broker.recoverExternalWorkspaceBinding(snapshot.bindingId(),
                snapshot.generation(), snapshot.version())
                .thenApply(binding -> {
                    requireOwner(tenantId, ownerUserId, workspaceId);
                    // native 完成时已释放 claim；读取释放后的版本，避免把旧快照的 live claim 当阻断。
                    RuntimeBindingRecord latest = bindings.findById(snapshot.bindingId());
                    if (latest == null || latest.getGeneration() != snapshot.generation()) {
                        throw blocked();
                    }
                    return candidate(latest, tenantId, workspaceId);
                });
    }

    private void requireOwner(String tenantId, String ownerUserId, String workspaceId) {
        if (workspaces.accessOf(tenantId, ownerUserId, workspaceId) != WorkspaceAccess.OWNER) {
            throw new RuntimeBrokerException(403, "external_workspace_recovery_forbidden",
                    "Workspace owner authorization is required", false);
        }
    }

    private Candidate candidate(RuntimeBindingRecord binding, String tenantId, String workspaceId) {
        return new Candidate(binding.getBindingId(), binding.getGeneration(), binding.getVersion(),
                binding.getState().name(), eligible(binding, tenantId, workspaceId));
    }

    private boolean eligible(RuntimeBindingRecord binding, String tenantId, String workspaceId) {
        var request = binding.getRequest();
        var scope = request.getScope();
        if (!tenantId.equals(scope.getTenantId()) || !workspaceId.equals(scope.getWorkspaceId())
                || !WorkspaceExecutionProfile.isExternalWorkspaceRequest(request)
                || !"workspace".equals(scope.getIsolationClass())
                || (binding.getState() != RuntimeBindingRecord.State.READY
                        && binding.getState() != RuntimeBindingRecord.State.RECOVERY_BLOCKED)
                || binding.isDrainRequested() || binding.getLease() == null
                || binding.getProvisionSeed() == null || !binding.getProvisionSeed().matches(binding.getLease())
                || binding.getResourceHandle() == null
                || (binding.getOperationOwner() != null && (binding.getOperationLeaseUntil() == null
                        || binding.getOperationLeaseUntil().isAfter(Instant.now())))
                || bindings.isStorageFenced(tenantId, request.getStorageId(), null)
                || executions.hasActiveByBinding(binding.getBindingId(), binding.getGeneration())) {
            return false;
        }
        try {
            return workspaces.bindingCurrent(tenantId, workspaceId,
                    Long.parseLong(scope.getWorkspaceGeneration()), request.getStorageId());
        } catch (NumberFormatException invalid) {
            return false;
        }
    }

    private static RuntimeBrokerException blocked() {
        return new RuntimeBrokerException(409, "external_workspace_recovery_blocked",
                "Original durable Workspace recovery evidence is missing, stale or unsettled", false);
    }

    public record Candidate(String bindingId, long generation, long version, String state, boolean eligible) { }

    /** 不可自行构造；Jackson 不导出原始 boot token，toString 也不输出任何恢复凭据。 */
    public static final class Snapshot {
        private final String tenantId;
        private final String ownerUserId;
        private final String workspaceId;
        private final String bindingId;
        private final long generation;
        private final long version;
        @JsonIgnore private final Map<String, Object> providerRequest;
        @JsonIgnore private final URI originalEndpoint;

        private Snapshot(String tenantId, String ownerUserId, String workspaceId, String bindingId,
                long generation, long version, Map<String, Object> providerRequest, URI originalEndpoint) {
            this.tenantId = tenantId;
            this.ownerUserId = ownerUserId;
            this.workspaceId = workspaceId;
            this.bindingId = bindingId;
            this.generation = generation;
            this.version = version;
            this.providerRequest = providerRequest;
            this.originalEndpoint = originalEndpoint;
        }

        public String bindingId() { return bindingId; }
        public long generation() { return generation; }
        public long version() { return version; }
        @JsonIgnore public Map<String, Object> providerRequest() { return providerRequest; }
        @JsonIgnore public URI originalEndpoint() { return originalEndpoint; }
        @Override public String toString() { return "ExternalWorkspaceRecoverySnapshot[redacted]"; }
    }
}
