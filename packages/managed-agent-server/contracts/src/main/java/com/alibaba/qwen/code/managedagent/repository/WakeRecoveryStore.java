package com.alibaba.qwen.code.managedagent.repository;

import java.util.List;
import java.util.Optional;

public interface WakeRecoveryStore {
    public record Candidate(String tenantId, String workspaceId, String sessionId,
            long journalRevision, long committedSequence, long compactedThroughRevision,
            String parentSessionId, String parentChildRunId) {
    }

    public List<Candidate> findPending(String defaultWorkspace, int limit);

    public boolean claim(Candidate candidate);

    public Optional<Boolean> hasPendingInput(Candidate candidate);

    public boolean recordPending(Candidate candidate, boolean pending);
}
