package com.alibaba.qwen.code.managedagent.contracts.workspace;

import com.alibaba.qwen.code.managedagent.repository.WorkspaceCsiReservations;
import com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore;
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

    /**
     * Whether a selection could resolve to a configured Resident Workspace, decided from
     * configuration alone before any row is read: true for the tenant's default Workspace
     * (workspaceId null) whenever the tenant configures one.
     */
    public boolean mayContain(String tenantId, String workspaceId) {
        return configured.stream().anyMatch(value -> value.registration().tenantId().equals(tenantId)
                && (workspaceId == null || value.workspaceId().equals(workspaceId)));
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
            throw WorkspaceExecutionStore.unavailable();
        }
        return configured.stream().filter(value -> value.registration().tenantId().equals(scope.getTenantId())
                && value.workspaceId().equals(scope.getWorkspaceId())
                && Long.toString(value.workspaceGeneration()).equals(scope.getWorkspaceGeneration())
                && value.registration().mountRoot().equals(scope.getCanonicalCwd()))
                .findFirst().orElseThrow(WorkspaceExecutionStore::unavailable);
    }

    public RuntimeProvisionRequest request(ContextBinding binding) {
        var selected = find(binding);
        if (selected == null) {
            throw WorkspaceExecutionStore.unavailable();
        }
        return new RuntimeProvisionRequest(scope(selected), null, WorkspaceCsiReservations.PROVISIONER_KIND,
                selected.registration().storageId());
    }

    public static RuntimeScope scope(ResidentWorkspace selected) {
        return new RuntimeScope(selected.registration().tenantId(), selected.workspaceId(),
                Long.toString(selected.workspaceGeneration()), selected.registration().mountRoot(),
                ResidentWorkspaceProfile.CAPABILITY_DIGEST, "workspace");
    }
}
