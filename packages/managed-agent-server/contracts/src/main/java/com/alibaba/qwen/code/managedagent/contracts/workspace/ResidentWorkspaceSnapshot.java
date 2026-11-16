package com.alibaba.qwen.code.managedagent.contracts.workspace;

import com.alibaba.qwen.code.managedagent.contracts.persistence.WorkspaceCsiRegistration;
import com.alibaba.qwen.code.managedagent.contracts.runtime.ProtectionIdentity;
import com.alibaba.qwen.code.managedagent.contracts.runtime.WorkerArtifact;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;

import java.util.List;
import java.util.Objects;

public record ResidentWorkspaceSnapshot(
        String workspaceId,
        long workspaceGeneration,
        WorkspaceCsiRegistration
                registration,
        ProtectionIdentity protection,
        String image,
        List<String> command,
        List<WorkerArtifact> artifacts)
        implements ManagedAgentSettings.RuntimeBroker
                .ResidentWorkspace {
    public ResidentWorkspaceSnapshot {
        if (registration == null
                || protection == null
                || workspaceId == null
                || workspaceId.isBlank()
                || workspaceGeneration < 1
                || image == null
                || !image.matches("[^\\s]+@sha256:[0-9a-f]{64}")
                || command == null
                || command.isEmpty()
                || command.size() > 32
                || command.stream()
                        .anyMatch(
                                value ->
                                        value == null
                                                || value.isBlank()
                                                || value.length() > 8192
                                                || value.indexOf('\0') >= 0)
                || artifacts == null
                || artifacts.size() > 48
                || artifacts.stream().anyMatch(Objects::isNull)
                || artifacts.stream()
                                .map(
                                        com.alibaba.qwen.code.managedagent.contracts.runtime
                                                        .WorkerArtifact
                                                ::configMapName)
                                .distinct()
                                .count()
                        != artifacts.size()) {
            throw new IllegalArgumentException("Invalid resident Workspace configuration");
        }
        new ContextBinding(
                registration.tenantId(),
                workspaceId,
                workspaceGeneration,
                registration.storageId(),
                ".",
                WorkspaceExecutionProfile.CONTEXT_CONFIG_REF,
                1);
        command = List.copyOf(command);
        artifacts = List.copyOf(artifacts);
    }
}
