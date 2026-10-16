package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;

import static org.assertj.core.api.Assertions.assertThat;

class ManagedReceiptsTest {
    @Test
    void preservesActorScopedReplayAndNullableCommandFields() {
        try (var fixture = ConsolidatedStoreFixture.open("typed_receipt")) {
            ManagedSchema.initialize(fixture.source());
            var jdbc = new ManagedSchemaJdbcTemplate(fixture.source());
            byte[] actor = "用户 ".getBytes(StandardCharsets.UTF_8);
            ManagedReceipts.insertCreation(jdbc, "tenant", actor, "create", "digest", "session", null, 123L);
            var receipt = ManagedReceipts.creation(jdbc, "tenant", actor, "create");
            assertThat(receipt.sessionId()).isEqualTo("session");
            assertThat(receipt.turnId()).isNull();
            assertThat(receipt.workspaceBound()).isTrue();
            assertThat(receipt.createdAt()).isEqualTo(123L);
            assertThat(receipt.updatedAt()).isEqualTo(123L);
            assertThat(ManagedReceipts.creation(jdbc, "tenant", "用户".getBytes(StandardCharsets.UTF_8), "create"))
                    .isNull();
            ManagedReceipts.insertCommand(jdbc, "tenant", "CLOSE", "close", "digest", "session", null,
                    "PENDING", null, 456L);
            var command = ManagedReceipts.command(jdbc, "tenant", "CLOSE", "close", false);
            assertThat(command.workspaceBound()).isNull();
            assertThat(command.sessionStatusBefore()).isNull();
            assertThat(command.state()).isEqualTo("PENDING");
        }
    }
}
