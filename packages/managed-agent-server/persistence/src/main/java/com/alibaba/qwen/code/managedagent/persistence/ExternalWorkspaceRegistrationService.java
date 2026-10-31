package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ExternalStorageRegistration;

import org.springframework.stereotype.Component;

/** 仅供可信宿主使用的注册入口，不暴露未经授权的用户自助授权接口。 */
@Component
public final class ExternalWorkspaceRegistrationService {
    private final ExternalStorageRegistrationStore storage;
    private final ExternalWorkspaceMaterializationStore workspaces;

    public ExternalWorkspaceRegistrationService(ExternalStorageRegistrationStore storage,
            ExternalWorkspaceMaterializationStore workspaces) {
        this.storage = storage;
        this.workspaces = workspaces;
    }

    public ExternalWorkspaceMaterializationStore.Receipt ensureRegistered(String tenantId, String actorId,
            String idempotencyKey, ExternalStorageRegistration registration, String displayName) {
        // 两步都有独立持久回执；中途失败只补齐原注册，不重新认领其他物理资源。
        storage.registerExternalStorage(tenantId, idempotencyKey, registration);
        return workspaces.materialize(tenantId, registration.alias().tenantWorkspaceId(), displayName,
                actorId, idempotencyKey);
    }
    public ExternalWorkspaceMaterializationStore.Receipt ensureEphemeralRegistered(String tenantId, String actorId,
            String idempotencyKey, EphemeralWorkspaceRegistration registration, String displayName) {
        storage.registerEphemeralWorkspace(tenantId, idempotencyKey, registration);
        return workspaces.materialize(tenantId, registration.workspaceId(), displayName, actorId, idempotencyKey);
    }
    public EphemeralWorkspaceRegistration requireEphemeralRegistration(String tenantId, String workspaceId) {
        var registered = storage.find(tenantId, workspaceId)
                .filter(value -> value.ephemeral() && tenantId.equals(value.ephemeralTenantId())
                        && workspaceId.equals(value.tenantWorkspaceId()))
                .orElseThrow(() -> new com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException(409,
                        "ephemeral_workspace_registration_not_found", "Ephemeral Workspace is not registered.", false));
        return new EphemeralWorkspaceRegistration(registered.providerId(), registered.tenantWorkspaceId(),
                registered.mountRoot(), registered.registrationRevision());
    }
}
