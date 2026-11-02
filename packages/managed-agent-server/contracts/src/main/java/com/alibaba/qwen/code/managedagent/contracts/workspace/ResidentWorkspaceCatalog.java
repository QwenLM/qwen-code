package com.alibaba.qwen.code.managedagent.contracts.workspace;

import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings.RuntimeBroker.ResidentWorkspace;
import com.alibaba.qwen.code.runtimebroker.ResidentWorkspaceProfile;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;

import java.util.HashSet;
import java.util.List;
public class ResidentWorkspaceCatalog {
    protected final List<ResidentWorkspace> configured;

    public ResidentWorkspaceCatalog(List<? extends ResidentWorkspace> configured) {
        this.configured = List.copyOf(configured);
        var workspaces = new HashSet<List<String>>();
        var aliases = new HashSet<String>();
        var physical = new HashSet<String>();
        for (var entry : configured) {
            if (!workspaces.add(List.of(entry.registration().tenantId(), entry.workspaceId()))
                    || !aliases.add(entry.registration().aliasKey()) || !physical.add(entry.registration().physicalKey())) {
                throw new IllegalArgumentException("Resident Workspace ownership is duplicated");
            }
        }
    }

    public ResidentWorkspace find(ContextBinding binding) {
        if (binding == null) {
            return null;
        }
        return configured.stream().filter(value -> value.registration().tenantId().equals(binding.getTenantId())
                && value.workspaceId().equals(binding.getWorkspaceId())
                && value.workspaceGeneration() == binding.getWorkspaceGeneration()
                && value.registration().storageId().equals(binding.getStorageId())
                && WorkspaceExecutionProfile.CONTEXT_CONFIG_REF.equals(binding.getContextConfigRef()))
                .findFirst().orElse(null);
    }

    public ResidentWorkspace require(RuntimeScope scope) {
        if (!ResidentWorkspaceProfile.selects(scope)) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
        }
        return configured.stream().filter(value -> value.registration().tenantId().equals(scope.getTenantId())
                && value.workspaceId().equals(scope.getWorkspaceId())
                && Long.toString(value.workspaceGeneration()).equals(scope.getWorkspaceGeneration())
                && value.registration().mountRoot().equals(scope.getCanonicalCwd()))
                .findFirst().orElseThrow(com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore::unavailable);
    }

    public RuntimeProvisionRequest request(ContextBinding binding) {
        var selected = find(binding);
        if (selected == null) {
            throw com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable();
        }
        return new RuntimeProvisionRequest(scope(selected), null, com.alibaba.qwen.code.managedagent.repository.WorkspaceCsiReservations.PROVISIONER_KIND,
                selected.registration().storageId());
    }

    public static RuntimeScope scope(ResidentWorkspace selected) {
        return new RuntimeScope(selected.registration().tenantId(), selected.workspaceId(),
                Long.toString(selected.workspaceGeneration()), selected.registration().mountRoot(),
                ResidentWorkspaceProfile.CAPABILITY_DIGEST, "workspace");
    }
}
