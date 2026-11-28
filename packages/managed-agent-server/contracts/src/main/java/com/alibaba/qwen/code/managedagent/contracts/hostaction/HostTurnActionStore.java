package com.alibaba.qwen.code.managedagent.contracts.hostaction;

import java.util.List;
import java.util.Map;
import java.util.function.Supplier;

/**
 * Persistence and Broker dispatch boundary for Turn-scoped host actions.
 */
public interface HostTurnActionStore {
    boolean isAvailable();

    <T> T inTransaction(Supplier<T> work);

    void saveForTurn(String tenantId, String sessionId, String turnId, List<HostTurnActionSpec> specs);

    List<Map<String, Object>> wireActionsForPrompt(String tenantId, String sessionId, String promptId);

    Map<String, Object> executeFromBroker(String harnessSessionId, Map<String, Object> requestBody);

    List<HostTurnActionReceipt> listReceipts(String tenantId, String sessionId, String turnId);
}
