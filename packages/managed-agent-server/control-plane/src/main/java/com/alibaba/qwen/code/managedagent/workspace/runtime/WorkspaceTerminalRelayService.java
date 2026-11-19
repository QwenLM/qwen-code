package com.alibaba.qwen.code.managedagent.workspace.runtime;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.session.ManagedAgentService;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerOperations;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;

/**
 * Resolves the Runtime a Managed Web Terminal relays to. The handshake
 * admission (readable, active, Shell, OPERATOR) is owned by
 * {@link ManagedAgentService#admitTerminalSession}; this service adds the
 * terminal deployment opt-in and requires the Session's own binding to be
 * READY, undrained and terminal-capable. Every ambiguous or non-terminal
 * state fails closed; the relay never falls back to another Runtime.
 */
public final class WorkspaceTerminalRelayService {
    private final ManagedAgentService sessions;
    private final RuntimeBrokerOperations broker;
    private final ManagedAgentSettings settings;

    public WorkspaceTerminalRelayService(ManagedAgentService sessions,
            RuntimeBrokerOperations broker, ManagedAgentSettings settings) {
        this.sessions = sessions;
        this.broker = broker;
        this.settings = settings;
    }

    /** The admitted, terminal-capable binding the relay connects to. */
    public RuntimeBindingRecord admit(String tenantId, String actorId,
            String sessionId) {
        if (!settings.getRuntimeBroker().isWebTerminal()) {
            throw new ManagedAgentException(409, "workspace_unavailable",
                    "The Managed web terminal is not enabled.");
        }
        sessions.admitTerminalSession(tenantId, actorId, sessionId);
        RuntimeBindingRecord binding =
                broker.findLatestBindingByHarnessSession(tenantId, sessionId);
        if (binding == null
                || binding.getState() != RuntimeBindingRecord.State.READY
                || binding.isDrainRequested()
                || binding.getLease() == null
                || binding.getRequest() == null
                || !WorkspaceExecutionProfile.TERMINAL_CAPABILITY_DIGEST.equals(
                        binding.getRequest().getScope().getCapabilityDigest())) {
            throw new ManagedAgentException(409, "workspace_unavailable",
                    "The Session runtime does not admit a terminal.");
        }
        return binding;
    }
}
