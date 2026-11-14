package com.alibaba.qwen.code.managedagent.contracts.runtime;

public record Receipt(
        String physicalKey,
        long registrationRevision,
        String namespaceUid,
        String pvcResourceVersion,
        String pvResourceVersion,
        ProtectionIdentity protection) {}
