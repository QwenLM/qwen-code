package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
import org.junit.jupiter.api.Test;

/**
 * The lifecycle protocol an ACTIVE Workspace close or delete admits under:
 * protocol 1 only where the Harness `/lifecycle` route and the effects
 * receipt accept the profile (Files). A Shell-lane Session — every H4b
 * parent — keeps the protocol-0 close; under protocol 1 its child cascade
 * is fenced and its settlement ends `workspace_lifecycle_profile_unavailable`.
 */
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
    void shellProfileKeepsTheOrdinaryClose() {
        SessionRecord shell = session("ACTIVE", "hosted-workspace-shell/1");
        assertThat(SessionLifecycleService.usesLifecycleProtocol(shell,
                OperationKind.CLOSE)).isFalse();
        assertThat(SessionLifecycleService.usesLifecycleProtocol(shell,
                OperationKind.DELETE)).isFalse();
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
