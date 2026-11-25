package com.alibaba.qwen.code.managedagent.persistence;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class ToolPublicationObjectKeysTest {
    @Test
    void buildsPlaintextIdentityKeyForSlot() {
        var key = new ObjectMapper().createObjectNode()
                .put("tenantId", "tenant-a")
                .put("workspaceId", "workspace-b")
                .put("sessionId", "session-c");

        assertThat(ToolPublicationObjectKeys.forSlot(key, "publication-1", "segment:stdout:0"))
                .isEqualTo("managed-tool-results/tenant-a/workspace-b/session-c/"
                        + "publication-1/segment:stdout:0");
    }
}
