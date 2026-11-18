package com.alibaba.qwen.code.runtimebroker.spi;

import com.alibaba.qwen.code.managedagent.contracts.persistence.WorkspaceCsiRegistration;
import com.alibaba.qwen.code.managedagent.contracts.runtime.ProtectionIdentity;
import com.alibaba.qwen.code.managedagent.contracts.runtime.WorkerArtifact;

import java.time.Duration;
import java.util.List;

public record WorkspaceCsiRuntimeSpec(WorkspaceCsiRegistration registration,
        ProtectionIdentity protection, String clusterDomain, String image, List<String> command,
        List<WorkerArtifact> artifacts, Duration startupTimeout, String authorityOrigin) {
    public WorkspaceCsiRuntimeSpec {
        command = List.copyOf(command);
        artifacts = List.copyOf(artifacts);
    }
}
