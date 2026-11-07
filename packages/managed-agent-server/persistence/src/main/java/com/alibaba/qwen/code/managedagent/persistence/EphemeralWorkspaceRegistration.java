package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ExternalStorageRegistration;
import com.alibaba.qwen.code.runtimebroker.spi.ExternalStorageRegistry;

/** 临时目录只属于一次 Sandbox 生命周期，不声明可重新挂载的物理卷。 */
public record EphemeralWorkspaceRegistration(String providerId, String workspaceId,
        String mountRoot, long registrationRevision) {
    public EphemeralWorkspaceRegistration {
        new ExternalStorageRegistration.StorageAlias(workspaceId, mountRoot, mountRoot);
        if (providerId == null || !providerId.matches("[A-Za-z0-9._-]{1,128}")
                || registrationRevision < 1
                || registrationRevision > ExternalStorageRegistration.ExternalStorageIdentity.MAX_REGISTRATION_REVISION) {
            throw new IllegalArgumentException("Invalid ephemeral Workspace registration.");
        }
    }

    ExternalStorageRegistry.RegisteredExternalStorage registered(String tenantId) {
        return new ExternalStorageRegistry.RegisteredExternalStorage(providerId, null,
                registrationRevision, workspaceId, mountRoot, mountRoot, tenantId);
    }
}
