package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;

import java.sql.Timestamp;

final class ToolPublicationRequirements {

    private ToolPublicationRequirements() {
    }

    static void requireCapacity(long requested, long available) {
        if (requested > available) {
            throw new ManagedAgentException(507,
                    "managed_tool_publication_quota_exhausted",
                    "Tool publication capacity is exhausted");
        }
    }

    static void requireUnexpired(Timestamp deadline, Timestamp current) {
        requireContract(deadline.after(current), 409,
                "managed_tool_publication_operation_expired", "Publication operation expired");
    }

    static void requireContract(boolean valid, int status, String code, String message) {
        if (!valid) {
            throw new ManagedAgentException(status, code, message);
        }
    }
}
