package com.alibaba.qwen.code.managedagent.workspace.runtime;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerOperations;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.net.URI;
import java.time.Instant;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * The relay admits only a terminal-capable READY binding behind the terminal
 * opt-in; every other state fails closed and never falls back.
 */
class WorkspaceTerminalRelayServiceTest {
    private static final String TENANT = "terminal-tenant";
    private static final String ACTOR = "actor-a";
    private static final String SESSION = "session-a";
    private static final String WS = "ws-a";

    private ManagedAgentService sessions;
    private RuntimeBrokerOperations broker;
    private ManagedAgentSettings.RuntimeBroker brokerSettings;
    private WorkspaceTerminalRelayService relay;

    @BeforeEach
    void setUp() {
        sessions = mock(ManagedAgentService.class);
        broker = mock(RuntimeBrokerOperations.class);
        ManagedAgentSettings settings = mock(ManagedAgentSettings.class);
        brokerSettings = mock(ManagedAgentSettings.RuntimeBroker.class);
        when(settings.getRuntimeBroker()).thenReturn(brokerSettings);
        when(brokerSettings.isWebTerminal()).thenReturn(true);
        when(sessions.admitTerminalSession(anyString(), anyString(), anyString()))
                .thenReturn(null);
        relay = new WorkspaceTerminalRelayService(sessions, broker, settings);
    }

    private static RuntimeBindingRecord binding(String digest,
            RuntimeBindingRecord.State state, boolean drainRequested) {
        RuntimeScope scope = new RuntimeScope(TENANT, WS, "1", "/ws", digest,
                "session");
        RuntimeProvisionRequest request = new RuntimeProvisionRequest(scope,
                "iso", "static", null);
        RuntimeLease lease = new RuntimeLease("runtime-1",
                URI.create("http://127.0.0.1:43190"), "token", "lease-1", 7);
        return new RuntimeBindingRecord("binding-1", request, 1, state, lease,
                drainRequested, null, null, 0, 1, Instant.now(), Instant.now());
    }

    @Test
    void admitsATerminalCapableReadyBinding() {
        RuntimeBindingRecord ready = binding(
                WorkspaceExecutionProfile.TERMINAL_CAPABILITY_DIGEST,
                RuntimeBindingRecord.State.READY, false);
        when(broker.findLatestBindingByHarnessSession(TENANT, SESSION))
                .thenReturn(ready);
        assertThat(relay.admit(TENANT, ACTOR, SESSION)).isSameAs(ready);
    }

    @Test
    void optInOffRefuses() {
        when(brokerSettings.isWebTerminal()).thenReturn(false);
        assertThatThrownBy(() -> relay.admit(TENANT, ACTOR, SESSION))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getStatus()).isEqualTo(409));
    }

    @Test
    void nonTerminalDigestRefuses() {
        when(broker.findLatestBindingByHarnessSession(TENANT, SESSION))
                .thenReturn(binding(
                        WorkspaceExecutionProfile.MEASURED_CAPABILITY_DIGEST,
                        RuntimeBindingRecord.State.READY, false));
        assertThatThrownBy(() -> relay.admit(TENANT, ACTOR, SESSION))
                .isInstanceOf(ManagedAgentException.class);
    }

    @Test
    void drainingOrNonReadyRefuses() {
        when(broker.findLatestBindingByHarnessSession(TENANT, SESSION))
                .thenReturn(binding(
                        WorkspaceExecutionProfile.TERMINAL_CAPABILITY_DIGEST,
                        RuntimeBindingRecord.State.READY, true));
        assertThatThrownBy(() -> relay.admit(TENANT, ACTOR, SESSION))
                .isInstanceOf(ManagedAgentException.class);
        when(broker.findLatestBindingByHarnessSession(TENANT, SESSION))
                .thenReturn(binding(
                        WorkspaceExecutionProfile.TERMINAL_CAPABILITY_DIGEST,
                        RuntimeBindingRecord.State.DRAINING, false));
        assertThatThrownBy(() -> relay.admit(TENANT, ACTOR, SESSION))
                .isInstanceOf(ManagedAgentException.class);
    }

    @Test
    void missingBindingRefuses() {
        when(broker.findLatestBindingByHarnessSession(TENANT, SESSION))
                .thenReturn(null);
        assertThatThrownBy(() -> relay.admit(TENANT, ACTOR, SESSION))
                .isInstanceOf(ManagedAgentException.class);
    }
}
