package com.alibaba.qwen.code.managedagent.contracts.extensions;

import com.alibaba.qwen.code.managedagent.contracts.definitions.ManagedAgentDefinitionSource.Context;

import java.util.List;

public interface ManagedAgentBootstrapPreparation {
    List<PreparedBundle> prepare(Context context, List<AgentBootstrapBundleSource.BundleRef> bundles);

    record PreparedBundle(AgentBootstrapBundleSource.BundleRef source, String digest,
            long byteLength, boolean reused) {
        public PreparedBundle {
            if (source == null || digest == null || !digest.matches("[0-9a-f]{64}")
                    || !digest.equals(source.expectedDigest()) || byteLength < 1) {
                throw new IllegalArgumentException("Invalid prepared bundle");
            }
        }
    }
}
