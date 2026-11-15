package com.alibaba.qwen.code.managedagent.contracts.runtime;

import java.util.Objects;

import static com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity.dns;
import static com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity.require;
import static com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity.uuid;

public record WorkerArtifact(String configMapName, String uid, String sha256) {
    public WorkerArtifact {
        dns(Objects.requireNonNull(configMapName));
        uuid(Objects.requireNonNull(uid));
        require(sha256 != null && sha256.matches("[0-9a-f]{64}"));
    }
}
