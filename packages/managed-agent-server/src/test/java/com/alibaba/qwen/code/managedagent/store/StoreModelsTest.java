package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.store.StoreModels.CommandRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

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
                "profile-carry", "digest-carry");

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
        assertThat(projected.agentDefinitionDigest())
                .isEqualTo("digest-carry");
    }

    // The recorder half of every command replay gate. A stamped receipt
    // answers only its recorder; the UNATTRIBUTED stamp answers nobody, so
    // a server-keyed command stays on the creator gate; and a receipt
    // recorded before the stamp existed (NULL) keeps the role-gated replay
    // it was recorded under for any caller with an actor id.
    @Test
    void admitsReplayByFollowsTheRecorderStamp() {
        byte[] recorder = ManagedWorkspaceRegistry.actorKey("tenant", "actor-a");

        assertThat(command(recorder).admitsReplayBy("actor-a")).isTrue();
        assertThat(command(recorder).admitsReplayBy("actor-b")).isFalse();
        assertThat(command(recorder).admitsReplayBy("bad\nactor")).isFalse();
        assertThat(command(recorder).admitsReplayBy(null)).isFalse();

        assertThat(command(ManagedReceipts.UNATTRIBUTED).admitsReplayBy("actor-a"))
                .isFalse();
        assertThat(command(ManagedReceipts.UNATTRIBUTED).admitsReplayBy(null))
                .isFalse();

        assertThat(command(null).admitsReplayBy("actor-b")).isTrue();
        assertThat(command(null).admitsReplayBy(null)).isFalse();
    }

    // Every command receipt this build writes carries a recorder column: an
    // actor-less insert stores the zero-byte UNATTRIBUTED stamp, never the
    // NULL that marks a receipt recorded before the stamp existed.
    @Test
    void anActorlessCommandReceiptIsStampedUnattributed() {
        var data = new DriverManagerDataSource("jdbc:h2:mem:receipt-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "");
        ManagedSchema.initialize(data);
        var jdbc = new ManagedSchemaJdbcTemplate(data);
        ManagedReceipts.insertCommand(jdbc, "tenant", "CANCEL_TURN", "server-keyed",
                "digest", "session", "turn", "COMPLETED", null, 1);
        ManagedReceipts.insertCommand(jdbc, "tenant", "SUBMIT_TURN", "stamped",
                "digest", "session", "turn", "COMPLETED", null,
                ManagedWorkspaceRegistry.actorKey("tenant", "actor-a"), 1);

        byte[] unattributed = ManagedReceipts.command(jdbc, "tenant",
                "CANCEL_TURN", "server-keyed", false).actorKey();
        byte[] stamped = ManagedReceipts.command(jdbc, "tenant",
                "SUBMIT_TURN", "stamped", false).actorKey();

        assertThat(unattributed).isNotNull().isEmpty();
        assertThat(command(unattributed).admitsReplayBy("actor-b")).isFalse();
        assertThat(stamped).isEqualTo(
                ManagedWorkspaceRegistry.actorKey("tenant", "actor-a"));
    }

    private static CommandRecord command(byte[] actorKey) {
        return new CommandRecord("tenant", "RENAME_SESSION", "key",
                "digest", "session", null, "COMPLETED", "ACTIVE", actorKey,
                1L, 1L);
    }
}
