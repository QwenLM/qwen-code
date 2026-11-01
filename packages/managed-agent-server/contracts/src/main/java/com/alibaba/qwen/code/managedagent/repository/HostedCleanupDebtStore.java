package com.alibaba.qwen.code.managedagent.repository;

import java.util.List;

public interface HostedCleanupDebtStore {
    public record CleanupDebt(String tenantId, String workspaceId, String sessionId,
            String ownerKey, String promptId) {
    }

    /**
     * One advancing page. {@code nextCreate}/{@code nextOwnerKey} name the last
     * raw row read (valid or not) so the next call resumes after it;
     * {@code exhausted} is true when the query returned fewer rows than the
     * limit, meaning the cursor has reached the end and should wrap.
     */
    public record ScanPage(List<CleanupDebt> debts, long nextCreate, String nextOwnerKey,
            boolean exhausted) {
    }

    ScanPage findOwed(int limit, long afterCreate, String afterOwnerKey);
}
