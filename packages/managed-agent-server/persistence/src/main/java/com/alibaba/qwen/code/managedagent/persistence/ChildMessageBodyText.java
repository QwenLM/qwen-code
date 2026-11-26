package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ToolPublicationContract;
import org.springframework.jdbc.core.JdbcTemplate;

import java.nio.charset.StandardCharsets;

/** The child relay's message body read, split from the store's execution logic. */
final class ChildMessageBodyText {
    private ChildMessageBodyText() {}

    static String read(JdbcTemplate jdbc, String tenantId, String sessionId, String resourceId) {
        return jdbc.query(
                "SELECT inline_bytes, kind, schema_version, byte_length, sha256, state, deletion_operation_ref"
                        + " FROM ma_resource WHERE tenant_id = ? AND session_id = ? AND resource_id = ?",
                (result, row) -> {
                    byte[] bytes = result.getBytes("inline_bytes");
                    if (!"REFERENCED".equals(result.getString("state"))
                            || !"managed-message-parts".equals(result.getString("kind"))
                            || result.getInt("schema_version") != 1
                            || result.getString("deletion_operation_ref") != null || bytes == null
                            || bytes.length != result.getLong("byte_length")
                            || !ToolPublicationContract.sha256(bytes).equals(result.getString("sha256"))) {
                        throw new IllegalStateException("Child message body resource is unavailable or corrupt");
                    }
                    return new String(bytes, StandardCharsets.UTF_8);
                }, tenantId, sessionId, resourceId)
                .stream().findFirst()
                .orElseThrow(() -> new IllegalStateException("Child message body resource is unavailable or corrupt"));
    }
}
