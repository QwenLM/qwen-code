package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

/**
 * Decision 13 of the isolation slice (#13753 I1): an isolated child names
 * its run's child Workspace directory, which joins the request digest, and
 * a run without one refuses before anything is admitted.
 */
class ManagedAgentServiceChildWorkspaceTest {
    private static final String TENANT = "tenant";
    private static final String PARENT = "parent";
    private static final String RUN = "run-1";
    private static final String CWD = ".qwen-child-workspaces/0123456789abcdef0123456789abcdef";

    private final AgentStateStore store = mock(AgentStateStore.class);
    private final HarnessConnector harness = mock(HarnessConnector.class);
    private ManagedAgentService service;

    @BeforeEach
    void setUp() {
        when(harness.isWorkspaceFilesAvailable()).thenReturn(true);
        when(store.requireSession(TENANT, PARENT)).thenReturn(new StoreModels.SessionRecord(TENANT, PARENT,
                "qwen-code", null, "parent", "ACTIVE", null, null, 0, 0, 0, 0, 0, null, 0,
                new ContextBinding(TENANT, "workspace", 1, "storage", "project",
                        WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, 1), null, null));
        when(store.insertChildSessionCommand(anyString(), anyString(), anyString(), anyString(), anyString(),
                anyList(), any(), any(StoreModels.SessionLineage.class)))
                .thenReturn(new StoreModels.Admission("shared-child", null, false, true));
        when(store.insertChildSessionCommand(anyString(), anyString(), anyString(), anyString(), anyString(),
                anyList(), any(), any(StoreModels.SessionLineage.class), anyString()))
                .thenReturn(new StoreModels.Admission("isolated-child", null, false, true));
        service = new ManagedAgentService(store, new RequestDigests(), null, harness, null);
    }

    @Test
    void anIsolatedChildBindsItsRunsWorkspaceDirectoryUnderItsOwnDigest() {
        when(store.findChildWorkspaceCwd(TENANT, PARENT, RUN)).thenReturn(CWD);

        assertThat(service.createChildSession(TENANT, PARENT, RUN, "audit", "look", true).sessionId())
                .isEqualTo("isolated-child");
        assertThat(service.createChildSession(TENANT, PARENT, RUN, "audit", "look").sessionId())
                .isEqualTo("shared-child");

        ArgumentCaptor<String> isolated = ArgumentCaptor.forClass(String.class);
        verify(store).insertChildSessionCommand(eq(TENANT), eq(PARENT), anyString(), isolated.capture(),
                anyString(), anyList(), any(), any(StoreModels.SessionLineage.class), eq(CWD));
        ArgumentCaptor<String> shared = ArgumentCaptor.forClass(String.class);
        verify(store).insertChildSessionCommand(eq(TENANT), eq(PARENT), anyString(), shared.capture(),
                anyString(), anyList(), any(), any(StoreModels.SessionLineage.class));
        assertThat(isolated.getValue()).isNotEqualTo(shared.getValue());
    }

    @Test
    void aRunWithoutAChildWorkspaceRefusesTheIsolatedCreation() {
        assertThatThrownBy(() -> service.createChildSession(TENANT, PARENT, RUN, "audit", "look", true))
                .isInstanceOfSatisfying(ApiException.class,
                        error -> assertThat(error.getCode()).isEqualTo("child_workspace_not_ready"));
        verify(store, never()).insertChildSessionCommand(anyString(), anyString(), anyString(), anyString(),
                anyString(), anyList(), any(), any(StoreModels.SessionLineage.class), anyString());
    }
}
