package com.alibaba.qwen.code.managedagent.repository;

import java.util.List;

public interface SessionRecoveryRepository {
    public record HeadRecovery(String state, String reasonCode,
            String journalState, String activationPhase,
            Long activationHeadRevision, Long journalRevision) { }
    public List<HeadRecovery> heads(String tenantId, String sessionId);
    public long nonInitialTurns(String tenantId, String sessionId);
}
