package com.alibaba.qwen.code.managedagent.contracts.session;

import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.repository.SessionWorktreeStore;

import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The one workspace-bound Session creation command. Replaces the former
 * telescoping {@code insertWorkspaceSessionCommand} overload chain: the
 * store API keeps a single signature while capabilities grow as named
 * components.
 *
 * <p>Prefer {@link #builder()} at call sites. The canonical constructor
 * stays positional, so swapping two same-typed arguments still compiles;
 * the builder's per-component methods are the named-construction path
 * that closes that misordering risk. Adding a component changes the
 * canonical constructor signature, so every construction call site must
 * be updated in the same change.
 */
public record SessionCreationCommand(
        String tenantId, String actorId, String idempotencyKey,
        String requestDigest, String agentId, String requestedRevision,
        String title, List<Map<String, Object>> input, String payloadDigest,
        WorkspaceSelection selection, String requestedApprovalMode,
        boolean approvalSelectionSupported, Boolean requestedPlanMode,
        boolean planModeSupported, List<Map<String, Object>> skills,
        boolean publicChildrenSupported, String modelId,
        List<ManagedExtensionPackages.Pin> extensionPins,
        Set<String> extensionLifecycleProfiles,
        SessionWorktreeStore.Plan worktree) {
    public static Builder builder() {
        return new Builder();
    }

    /** Named construction; unset components keep the former chain's defaults. */
    public static final class Builder {
        private String tenantId;
        private String actorId;
        private String idempotencyKey;
        private String requestDigest;
        private String agentId;
        private String requestedRevision;
        private String title;
        private List<Map<String, Object>> input = List.of();
        private String payloadDigest;
        private WorkspaceSelection selection;
        private String requestedApprovalMode;
        private boolean approvalSelectionSupported;
        private Boolean requestedPlanMode;
        private boolean planModeSupported;
        private List<Map<String, Object>> skills = List.of();
        private boolean publicChildrenSupported;
        private String modelId;
        private List<ManagedExtensionPackages.Pin> extensionPins;
        private Set<String> extensionLifecycleProfiles = Set.of();
        private SessionWorktreeStore.Plan worktree;

        public Builder tenantId(String value) {
            this.tenantId = value;
            return this;
        }

        public Builder actorId(String value) {
            this.actorId = value;
            return this;
        }

        public Builder idempotencyKey(String value) {
            this.idempotencyKey = value;
            return this;
        }

        public Builder requestDigest(String value) {
            this.requestDigest = value;
            return this;
        }

        public Builder agentId(String value) {
            this.agentId = value;
            return this;
        }

        public Builder requestedRevision(String value) {
            this.requestedRevision = value;
            return this;
        }

        public Builder title(String value) {
            this.title = value;
            return this;
        }

        public Builder input(List<Map<String, Object>> value) {
            this.input = value;
            return this;
        }

        public Builder payloadDigest(String value) {
            this.payloadDigest = value;
            return this;
        }

        public Builder selection(WorkspaceSelection value) {
            this.selection = value;
            return this;
        }

        public Builder requestedApprovalMode(String value) {
            this.requestedApprovalMode = value;
            return this;
        }

        public Builder approvalSelectionSupported(boolean value) {
            this.approvalSelectionSupported = value;
            return this;
        }

        public Builder requestedPlanMode(Boolean value) {
            this.requestedPlanMode = value;
            return this;
        }

        public Builder planModeSupported(boolean value) {
            this.planModeSupported = value;
            return this;
        }

        public Builder skills(List<Map<String, Object>> value) {
            this.skills = value;
            return this;
        }

        public Builder publicChildrenSupported(boolean value) {
            this.publicChildrenSupported = value;
            return this;
        }

        public Builder modelId(String value) {
            this.modelId = value;
            return this;
        }

        public Builder extensionPins(List<ManagedExtensionPackages.Pin> value) {
            this.extensionPins = value;
            return this;
        }

        public Builder extensionLifecycleProfiles(Set<String> value) {
            this.extensionLifecycleProfiles = value;
            return this;
        }

        public Builder worktree(SessionWorktreeStore.Plan value) {
            this.worktree = value;
            return this;
        }

        public SessionCreationCommand build() {
            return new SessionCreationCommand(tenantId, actorId, idempotencyKey,
                    requestDigest, agentId, requestedRevision, title, input,
                    payloadDigest, selection, requestedApprovalMode,
                    approvalSelectionSupported, requestedPlanMode, planModeSupported,
                    skills, publicChildrenSupported, modelId, extensionPins,
                    extensionLifecycleProfiles, worktree);
        }
    }
}
