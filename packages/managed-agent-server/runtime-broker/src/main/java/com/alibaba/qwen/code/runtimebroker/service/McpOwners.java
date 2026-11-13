package com.alibaba.qwen.code.runtimebroker.service;

import com.alibaba.qwen.code.runtimebroker.BrokerValues;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository;

import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.conflict;

/**
 * Selects the Runtime Session that owns a Harness Session's MCP inventory.
 * A terminal's derived Runtime Session shares the Harness Session but is not
 * a second MCP owner, so it is excluded by its persisted turn kind; the
 * ambiguity guard still catches two genuine Runtime Sessions.
 */
final class McpOwners {
    private McpOwners() {
    }

    static RuntimeSessionRecord resolve(RuntimeSessionRepository sessions,
            RuntimeScope scope, String harnessId, String runtimeSessionId) {
        RuntimeSessionRecord owner = runtimeSessionId == null ? null
                : sessions.findHistorical(scope.getTenantId(), harnessId,
                        BrokerValues.requireId(runtimeSessionId, "runtimeSessionId"));
        if (runtimeSessionId != null && owner == null) {
            throw conflict("managed_mcp_owner_unavailable", "The original MCP owner is unavailable.");
        }
        if (owner == null) {
            var active = sessions.findActiveByHarnessSession(scope.getTenantId(), harnessId, null, 2,
                    TerminalHolds.TERMINAL_TURN_KIND);
            if (active.size() > 1) {
                throw conflict("managed_mcp_owner_unavailable", "The original MCP owner is ambiguous.");
            }
            owner = active.isEmpty() ? null : active.getFirst();
        }
        return owner;
    }
}
