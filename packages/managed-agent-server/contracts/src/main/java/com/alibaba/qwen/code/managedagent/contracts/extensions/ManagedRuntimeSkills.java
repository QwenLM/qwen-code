package com.alibaba.qwen.code.managedagent.contracts.extensions;

import com.fasterxml.jackson.annotation.JsonAnySetter;
import com.fasterxml.jackson.databind.JsonNode;

public final class ManagedRuntimeSkills {
    private ManagedRuntimeSkills() { }

    public record Owner(String bindingId, String generation) {
        @JsonAnySetter
        public void rejectUnknown(String name, JsonNode value) { throw new IllegalArgumentException("Unknown Runtime owner field"); }
    }

    public record SnapshotRequest(Owner owner, String path, String digest, ManagedExtensionPackages.Target target) {
        @JsonAnySetter
        public void rejectUnknown(String name, JsonNode value) { throw new IllegalArgumentException("Unknown Runtime Skill snapshot field"); }
    }

    public record ImportRequest(Owner owner, String operationId, String preparationId, String sourceDigest, long byteLength,
            ManagedExtensionPackages.Target target, String extensionId) {
        @JsonAnySetter
        public void rejectUnknown(String name, JsonNode value) { throw new IllegalArgumentException("Unknown Runtime Skill import field"); }
    }
}
