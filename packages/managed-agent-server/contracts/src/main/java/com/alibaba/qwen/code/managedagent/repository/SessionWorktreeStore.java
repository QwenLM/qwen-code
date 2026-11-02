package com.alibaba.qwen.code.managedagent.repository;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry.ResolvedBinding;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;

import java.nio.file.Path;
import java.util.List;
import java.util.Locale;

public interface SessionWorktreeStore {
    public static final String KIND = "SESSION_WORKTREE";

    public record Plan(String tenantId, String workspaceId, long workspaceGeneration, String storageId,
            String sourceCwdRelative, String contextConfigRef, long contextRevision, String root, String rootIdentity,
            String repositoryRelative, String sourceOffset, String commonDirectory, String commonIdentity,
            String baseRef, String baseCommit, String worktreeId, String worktreeRoot, String cwdRelative, String branch,
            String storageIdentity) {
        public Plan(String tenantId, String workspaceId, long workspaceGeneration, String storageId,
                String sourceCwdRelative, String contextConfigRef, long contextRevision, String root, String rootIdentity,
                String repositoryRelative, String sourceOffset, String commonDirectory, String commonIdentity,
                String baseRef, String baseCommit, String worktreeId, String worktreeRoot, String cwdRelative, String branch) {
            this(tenantId, workspaceId, workspaceGeneration, storageId, sourceCwdRelative, contextConfigRef, contextRevision,
                    root, rootIdentity, repositoryRelative, sourceOffset, commonDirectory, commonIdentity, baseRef,
                    baseCommit, worktreeId, worktreeRoot, cwdRelative, branch, null);
        }
        public ContextBinding source() {
            return new ContextBinding(tenantId, workspaceId, workspaceGeneration, storageId, sourceCwdRelative,
                    contextConfigRef, contextRevision);
        }

        public ResolvedBinding target(ResolvedBinding source) {
            if (!source().equals(source.binding())) {
                throw error("worktree_source_changed");
            }
            return new ResolvedBinding(new ContextBinding(tenantId, workspaceId, workspaceGeneration, storageId,
                    cwdRelative, source.binding().getContextConfigRef(), 1), source.configRef(), source.policyRef());
        }
    }

    public record Descriptor(String id, String sessionId, String workspaceId, String state, String branch,
            String baseCommit, String cwdRelative, String operationId, long revision, String errorCode) {
        public String worktreeId() {
            return id;
        }
    }

    public record Row(String tenantId, String sessionId, String workspaceId, String worktreeId, String state,
            Plan plan, String identityJson, String operationId, String claimedBy, long generation,
            Long claimUntil, String phase, int attempts, long revision, String errorCode, String actor) {
        public Descriptor descriptor() {
            return descriptor(plan.branch());
        }

        public Descriptor descriptor(String branch) {
            return new Descriptor(worktreeId, sessionId, workspaceId, state.toLowerCase(Locale.ROOT), branch,
                    plan.baseCommit(), plan.cwdRelative(), operationId, revision, errorCode);
        }
    }

    public record SourceLocation(ResolvedBinding resolved, Path root, String storageIdentity) { }

    public SourceLocation source(String tenant, String actor, com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceSelection selection);

    public void authorizeOptions(String tenant, String actor, String workspace);

    public boolean active(Row row);

    public Descriptor describe(String tenant, String session);

    public void admit(String tenant, String actor, String session, Plan plan, ResolvedBinding source);

    public Row get(String tenant, String actor, String workspace, String id, boolean write);

    public List<Descriptor> list(String tenant, String actor, String workspace);

    public List<Row> due();

    public List<String[]> failedInitialSessions();

    public Row claim(Row row, String owner, long leaseMillis);

    public boolean renew(Row row, String owner, long leaseMillis);

    public boolean complete(Row row, String owner, String state, String identity, String error);

    public void defer(Row row, String owner, String error);

    public void retry(Row row, String owner, String error);

    public void resumeStopped();

    public boolean maintenanceHeld(Row row);

    public Row cleanup(String tenant, String actor, String workspace, String id, String idempotencyKey);

    public String cleanupBlocker(Row row);

    public static ContextBinding storageBinding(Plan plan) {
        return new ContextBinding(plan.tenantId(), plan.workspaceId(), plan.workspaceGeneration(), plan.storageId(),
                ".", plan.contextConfigRef(), plan.contextRevision());
    }

    public static ManagedAgentException error(String code) {
        return new ManagedAgentException(409, code, "The Session worktree cannot perform this operation (" + code + ").");
    }
}
