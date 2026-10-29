package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.persistence.ManagedNativeJournalSnapshots;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels.RestoreHead;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels.ToolResultResourceRef;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class ManagedSnapshotRestoreResponseTest {
    private final ObjectMapper json = new ObjectMapper();

    @Test
    void absentSnapshotPreservesTheExactLegacyHeadShape() throws Exception {
        var head = head();
        var response = new ManagedSessionStoreController.RestoreResponse(head, null);
        assertThat(json.readTree(json.writeValueAsBytes(response)))
                .isEqualTo(json.readTree(json.writeValueAsBytes(head)));
    }

    @Test
    void snapshotIsAnOptionalSiblingOfTheOriginalHeadFields() throws Exception {
        var manifest = new ManagedNativeJournalSnapshots.Manifest("qwen-managed-native-session-snapshot/1",
                "committed-prefix-v1", "tenant", "workspace", "session", "snapshot", 1, 0, null,
                0, null, 1, 1, 0, "a".repeat(64));
        var descriptor = new ManagedNativeJournalSnapshots.Descriptor(manifest,
                new ToolResultResourceRef("manifest", "managed-native-journal-snapshot", 1, 100, "b".repeat(64)), false);
        var response = json.readTree(json.writeValueAsBytes(new ManagedSessionStoreController.RestoreResponse(head(), descriptor)));
        assertThat(response.path("nativeSnapshot").path("snapshot").path("snapshotId").asText()).isEqualTo("snapshot");
        assertThat(response.has("head")).isFalse();
        ((com.fasterxml.jackson.databind.node.ObjectNode) response).remove("nativeSnapshot");
        assertThat(response).isEqualTo(json.readTree(json.writeValueAsBytes(head())));
    }

    private RestoreHead head() {
        return new RestoreHead("ACTIVE", 1, 1, 1, 0, null, 0, null, 0, "READY", null);
    }
}
