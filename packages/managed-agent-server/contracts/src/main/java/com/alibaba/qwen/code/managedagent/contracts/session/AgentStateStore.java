package com.alibaba.qwen.code.managedagent.contracts.session;

/**
 * The full Managed Agent state surface, composed of the role interfaces.
 * Consumers inject the narrowest role they use; this composite remains for
 * implementations and tests that need the whole surface. Nested records and
 * constants resolve through inheritance from the role that owns them.
 */
public interface AgentStateStore extends
        SessionAdmissionStore,
        SessionLifecycleStore,
        SessionQueryStore,
        SessionPolicyStore,
        EventProjectionStore,
        TurnExecutionStore {
}
