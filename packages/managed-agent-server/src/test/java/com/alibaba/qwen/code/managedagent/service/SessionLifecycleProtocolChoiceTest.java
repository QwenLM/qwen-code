package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class SessionLifecycleProtocolChoiceTest {
    private static SessionRecord session(String status, String toolProfile) {
        return new SessionRecord("tenant", "session", "agent", "1", null,
                status, null, null, 0, 0, 0, 0, 0, null, 0, null, "yolo",
                toolProfile);
    }

    @Test
    void filesProfileActiveCloseAndDeleteUseTheLifecycleProtocol() {
        SessionRecord files = session("ACTIVE", "hosted-workspace-files/1");
        assertThat(SessionLifecycleService.usesLifecycleProtocol(files,
                OperationKind.CLOSE)).isTrue();
        assertThat(SessionLifecycleService.usesLifecycleProtocol(files,
                OperationKind.DELETE)).isTrue();
    }

    @Test
    void onlyExactShellAndMcpProfilesUseV2() {
        for (String profile : java.util.List.of("hosted-workspace-shell/1", "hosted-workspace-mcp/1")) {
            SessionRecord active = session("ACTIVE", profile);
            assertThat(SessionLifecycleService.usesLifecycleProtocol(active, OperationKind.CLOSE)).isTrue();
            assertThat(SessionLifecycleService.usesLifecycleProtocol(active, OperationKind.DELETE)).isTrue();
        }
        for (String profile : java.util.List.of("hosted-workspace-shell/2", "hosted-workspace-mcp/2", "hosted-workspace-team-lead/1")) {
            assertThat(SessionLifecycleService.usesLifecycleProtocol(session("ACTIVE", profile), OperationKind.CLOSE)).isFalse();
        }
    }

    @Test
    void onlyActiveCloseAndDeleteQualify() {
        assertThat(SessionLifecycleService.usesLifecycleProtocol(
                session("CLOSED", "hosted-workspace-files/1"),
                OperationKind.DELETE)).isFalse();
        assertThat(SessionLifecycleService.usesLifecycleProtocol(
                session("ACTIVE", "hosted-workspace-files/1"),
                OperationKind.ARCHIVE)).isFalse();
    }
}
