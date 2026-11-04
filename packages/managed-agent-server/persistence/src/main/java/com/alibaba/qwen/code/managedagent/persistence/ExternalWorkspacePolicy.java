package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.protocol.ExternalRuntimeKinds;
import org.springframework.jdbc.core.JdbcTemplate;

final class ExternalWorkspacePolicy {
    private final JdbcTemplate jdbc;
    private final String providerId;
    private final boolean foregroundShell;

    ExternalWorkspacePolicy(JdbcTemplate jdbc, ManagedAgentSettings.RuntimeBroker runtime, boolean workspaceShellEnabled) {
        this.jdbc = jdbc;
        this.providerId = ExternalRuntimeKinds.isFiles(runtime.getProvisioner()) ? runtime.getExternalProviderId() : null;
        this.foregroundShell = ExternalRuntimeKinds.isTools(runtime.getProvisioner()) && workspaceShellEnabled;
    }

    void requireUnboundSession() {
        if (providerId != null) {
            throw new ManagedAgentException(409, "unsupported_feature",
                    "External Runtime requires a registered Workspace selection.");
        }
    }

    boolean isExternal(ContextBinding binding) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage WHERE alias_key = ? AND storage_kind = 'EXTERNAL'",
                Long.class, JdbcRuntimeBindingRepository.storageAliasKey(binding.getTenantId(), binding.getStorageId())) == 1;
    }

    boolean requireCreation(ContextBinding binding, AgentSessionPolicies.AgentPin pin, boolean extensions) {
        boolean external = isExternal(binding);
        if (providerId != null && !external) {
            throw AgentSessionPolicies.workspaceExecutionUnavailable();
        }
        if (external) {
            requireFiles(binding, pin.toolProfile());
            if (pin.hooks() || pin.mcp() || extensions) {
                throw AgentSessionPolicies.workspaceExecutionUnavailable();
            }
        }
        return external;
    }

    void requireFiles(ContextBinding binding, String profile) {
        var storage = ExternalStorageRegistrationStore.executionStorage(jdbc, binding.getTenantId(), binding.getStorageId(), false);
        if (providerId == null || storage == null || !providerId.equals(storage.providerId())
                || !binding.getWorkspaceId().equals(storage.tenantWorkspaceId()) || !".".equals(binding.getCwdRelative())
                || !(WorkspaceToolProfiles.FILES.equals(profile) || foregroundShell && WorkspaceToolProfiles.SHELL.equals(profile))) {
            throw AgentSessionPolicies.workspaceExecutionUnavailable();
        }
    }
}
