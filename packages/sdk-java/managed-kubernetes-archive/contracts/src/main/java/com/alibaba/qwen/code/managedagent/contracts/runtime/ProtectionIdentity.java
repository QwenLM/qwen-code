package com.alibaba.qwen.code.managedagent.contracts.runtime;

import java.util.List;

public record ProtectionIdentity(String namespaceUid, String policyName, String policyUid,
            long policyGeneration, String bindingName, String bindingUid, long bindingGeneration) {
    public ProtectionIdentity {
        for (String value : List.of(namespaceUid, policyName, policyUid, bindingName, bindingUid)) {
            if (value.isBlank()
                    || value.length() > 253
                    || value.codePoints().anyMatch(point -> point < 33)) {
                throw new IllegalArgumentException("Invalid CSI protection identity");
            }
        }
        if (policyGeneration < 1 || bindingGeneration < 1) {
            throw new IllegalArgumentException("Invalid CSI protection generation");
        }
    }
}
