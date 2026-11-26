package com.alibaba.qwen.code.managedagent.contracts.workspace;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class WorkspaceToolProfilesTest {
    @Test
    void onlyTheAskingProfilesPublishTheModesThatPrompt() {
        for (String profile : new String[] {WorkspaceToolProfiles.SHELL,
                WorkspaceToolProfiles.SHELL_V3, WorkspaceToolProfiles.SHELL_V4,
                WorkspaceToolProfiles.EXTERNAL_SHELL}) {
            assertThat(WorkspaceToolProfiles.approvalModes(profile))
                    .containsExactly("default", "auto-edit");
        }
        assertThat(WorkspaceToolProfiles.approvalModes(WorkspaceToolProfiles.FILES))
                .containsExactly("default", "auto-edit", "yolo");
        assertThat(WorkspaceToolProfiles.approvalModes(WorkspaceToolProfiles.EXTERNAL_FILES))
                .containsExactly("default", "auto-edit", "yolo");
    }

    /**
     * The stored-mode gate is narrower than the published choices: only the
     * external Shell lane constrains a mode the Session already holds. External
     * files may hold the live classifier's `auto`, which no profile publishes as
     * a creation choice, so gating every profile here would refuse a Turn the
     * Session was admitted to run.
     */
    @Test
    void theStoredModeGateRefusesOnlyTheExternalShellLane() {
        for (String mode : new String[] {"yolo", "auto"}) {
            assertThat(WorkspaceToolProfiles.admitsExternalApprovalMode(
                    WorkspaceToolProfiles.EXTERNAL_SHELL, mode)).isFalse();
            assertThat(WorkspaceToolProfiles.admitsExternalApprovalMode(
                    WorkspaceToolProfiles.EXTERNAL_FILES, mode)).isTrue();
        }
        for (String mode : new String[] {"default", "auto-edit"}) {
            assertThat(WorkspaceToolProfiles.admitsExternalApprovalMode(
                    WorkspaceToolProfiles.EXTERNAL_SHELL, mode)).isTrue();
        }
    }
}
