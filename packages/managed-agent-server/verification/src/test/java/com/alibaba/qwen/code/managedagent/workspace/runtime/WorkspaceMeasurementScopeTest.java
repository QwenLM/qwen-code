package com.alibaba.qwen.code.managedagent.workspace.runtime;

import com.alibaba.qwen.code.runtimebroker.CsiFilesRetirementProfile;
import com.alibaba.qwen.code.runtimebroker.ManagedExtensionExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.ResidentWorkspaceProfile;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class WorkspaceMeasurementScopeTest {
    private static RuntimeScope scope(String tenant, String workspace, String generation,
            String cwd, String profile, String isolation) {
        return new RuntimeScope(tenant, workspace, generation, cwd, profile, isolation);
    }

    @Test
    void recordedOrdinaryProfileSurvivesEnableAndDisableButOtherScopeChangesStayClosed() {
        String old = WorkspaceExecutionProfile.CAPABILITY_DIGEST;
        String measured = WorkspaceExecutionProfile.MEASURED_CAPABILITY_DIGEST;
        for (String isolation : List.of("session", "workspace")) {
            var original = scope("tenant", "workspace", "1", "/workspace", old, isolation);
            var next = scope("tenant", "workspace", "1", "/workspace", measured, isolation);
            assertThat(WorkspaceRuntimeResolver.matchesRecordedScope(next, original)).isTrue();
            assertThat(WorkspaceRuntimeResolver.matchesRecordedScope(original, next)).isTrue();
            for (var changed : List.of(
                    scope("other", "workspace", "1", "/workspace", measured, isolation),
                    scope("tenant", "other", "1", "/workspace", measured, isolation),
                    scope("tenant", "workspace", "2", "/workspace", measured, isolation),
                    scope("tenant", "workspace", "1", "/other", measured, isolation),
                    scope("tenant", "workspace", "1", "/workspace", measured, isolation.equals("session") ? "workspace" : "session"))) {
                assertThat(WorkspaceRuntimeResolver.matchesRecordedScope(changed, original)).isFalse();
            }
            for (String unrelated : List.of(CsiFilesRetirementProfile.CAPABILITY_DIGEST,
                    CsiFilesRetirementProfile.DIAGNOSTICS_DIGEST, ResidentWorkspaceProfile.CAPABILITY_DIGEST,
                    ManagedExtensionExecutionProfile.LINUX_CAPABILITY_DIGEST)) {
                var foreign = scope("tenant", "workspace", "1", "/workspace", unrelated, isolation);
                assertThat(WorkspaceRuntimeResolver.matchesRecordedScope(next, foreign)).isFalse();
                assertThat(WorkspaceRuntimeResolver.matchesRecordedScope(foreign, original)).isFalse();
            }
        }
    }

    @Test
    void recordedOrdinaryProfileSurvivesTheWebTerminalOptInToggle() {
        String old = WorkspaceExecutionProfile.CAPABILITY_DIGEST;
        String measured = WorkspaceExecutionProfile.MEASURED_CAPABILITY_DIGEST;
        String terminal = WorkspaceExecutionProfile.TERMINAL_CAPABILITY_DIGEST;
        for (String isolation : List.of("session", "workspace")) {
            // Enabling the opt-in substitutes the terminal digest on a Session whose
            // binding was recorded at the measured (or pre-measurement) digest; the
            // scope match must tolerate both directions, and disabling it again.
            for (String recorded : List.of(old, measured)) {
                var original = scope("tenant", "workspace", "1", "/workspace", recorded, isolation);
                var next = scope("tenant", "workspace", "1", "/workspace", terminal, isolation);
                assertThat(WorkspaceRuntimeResolver.matchesRecordedScope(next, original)).isTrue();
                assertThat(WorkspaceRuntimeResolver.matchesRecordedScope(original, next)).isTrue();
            }
            // The tolerance stays closed against non-ordinary profiles in both directions.
            var terminalScope = scope("tenant", "workspace", "1", "/workspace", terminal, isolation);
            for (String unrelated : List.of(CsiFilesRetirementProfile.CAPABILITY_DIGEST,
                    CsiFilesRetirementProfile.DIAGNOSTICS_DIGEST, ResidentWorkspaceProfile.CAPABILITY_DIGEST,
                    ManagedExtensionExecutionProfile.LINUX_CAPABILITY_DIGEST)) {
                var foreign = scope("tenant", "workspace", "1", "/workspace", unrelated, isolation);
                assertThat(WorkspaceRuntimeResolver.matchesRecordedScope(terminalScope, foreign)).isFalse();
                assertThat(WorkspaceRuntimeResolver.matchesRecordedScope(foreign, terminalScope)).isFalse();
            }
        }
    }
}
