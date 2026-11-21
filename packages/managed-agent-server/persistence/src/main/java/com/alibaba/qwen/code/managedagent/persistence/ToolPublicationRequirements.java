package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.fasterxml.jackson.databind.JsonNode;

import java.sql.Timestamp;
import java.util.Map;

final class ToolPublicationRequirements {
    private ToolPublicationRequirements() {
    }

    static boolean referenced(Map<String, Object> row, JsonNode outcomeRef, long revision, long sequence) {
        return row != null && "REFERENCED".equals(row.get("producer_phase"))
                && row.get("is_quarantined") instanceof Number mark && mark.intValue() == 0
                && outcomeRef != null && outcomeRef.path("resourceId").isTextual()
                && outcomeRef.path("resourceId").asText().equals(row.get("admission_resource_id"))
                && row.get("receipt_revision") instanceof Number r && r.longValue() == revision
                && row.get("receipt_sequence") instanceof Number q && q.longValue() == sequence;
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
