package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import org.junit.jupiter.api.Test;

class StoreModelsTest {

    // withStatus re-invokes the canonical constructor positionally, so a
    // dropped component between two same-typed neighbours still compiles and
    // silently shifts every later argument. Build a record with a distinct
    // value per component and pin each one through the projection.
    @Test
    void withStatusCarriesEveryComponent() {
        ContextBinding workspace = new ContextBinding("tenant-carry",
                "ws-carry", 3, "storage-carry", ".", "config-carry", 4);
        SessionRecord session = new SessionRecord("tenant-carry",
                "session-carry", "agent-carry", "revision-carry",
                "title-carry", "ACTIVE", "boot-carry", "epoch-carry", 11L,
                12L, 13L, 14L, 15L, 16L, 17L, workspace, "approval-carry",
                "profile-carry");

        SessionRecord projected = session.withStatus("CLOSED");

        assertThat(projected.status()).isEqualTo("CLOSED");
        assertThat(projected.tenantId()).isEqualTo("tenant-carry");
        assertThat(projected.sessionId()).isEqualTo("session-carry");
        assertThat(projected.agentId()).isEqualTo("agent-carry");
        assertThat(projected.agentRevision()).isEqualTo("revision-carry");
        assertThat(projected.title()).isEqualTo("title-carry");
        assertThat(projected.harnessBootId()).isEqualTo("boot-carry");
        assertThat(projected.harnessEventEpoch()).isEqualTo("epoch-carry");
        assertThat(projected.harnessLastEventId()).isEqualTo(11L);
        assertThat(projected.lastSequence()).isEqualTo(12L);
        assertThat(projected.replayFloorSequence()).isEqualTo(13L);
        assertThat(projected.createdAt()).isEqualTo(14L);
        assertThat(projected.updatedAt()).isEqualTo(15L);
        assertThat(projected.deletedAt()).isEqualTo(16L);
        assertThat(projected.version()).isEqualTo(17L);
        assertThat(projected.workspace()).isSameAs(workspace);
        assertThat(projected.approvalMode()).isEqualTo("approval-carry");
        assertThat(projected.toolProfile()).isEqualTo("profile-carry");
    }
}
