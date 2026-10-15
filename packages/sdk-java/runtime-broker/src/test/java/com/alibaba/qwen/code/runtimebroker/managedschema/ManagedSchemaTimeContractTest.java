package com.alibaba.qwen.code.runtimebroker.managedschema;

import static org.junit.jupiter.api.Assertions.assertAll;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.sql.Types;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.function.Executable;

class ManagedSchemaTimeContractTest {
    private static final List<String> TIMESTAMPS = List.of(
            "ma_session=gmt_create,gmt_modified,deleted_at,retired_at",
            "ma_turn=dispatch_lease_until,gmt_create,gmt_modified,completed_at,retry_after",
            "ma_session_head=writer_lease_until,gmt_create,gmt_modified,"
                    + "activation_expires_at,claim_lease_until",
            "ma_session_journal_tx=gmt_create",
            "ma_event_stream=snapshot_stale_since,gmt_modified",
            "ma_public_event=gmt_create",
            "ma_message=gmt_create,gmt_modified",
            "ma_snapshot=gmt_create,published_at,retain_until",
            "ma_session_record=gmt_create,started_at,settled_at",
            "ma_agent_definition=gmt_create",
            "ma_resource=gmt_create,last_verified_at,retention_until",
            "ma_resource_ref=gmt_create",
            "ma_output_capture=expires_at,collected_at,gmt_create,gmt_modified",
            "ma_request_receipt=gmt_create,gmt_modified",
            "ma_operation=claim_until,available_at,deadline,recovery_deadline,"
                    + "verification_next_at,gmt_create,gmt_modified,completed_at",
            "ma_operation_work=gmt_create,gmt_modified",
            "ma_workspace=gmt_create,gmt_modified",
            "ma_storage=gmt_create,gmt_modified",
            "ma_runtime_binding=operation_lease_until,last_health_at,last_reconciled_at,last_active_at",
            "ma_runtime_session=last_active_at",
            "ma_tool_execution=dispatch_lease_until,settled_at,abandoned_at",
            "ma_read_lease=expires_at",
            "ma_channel_instance=gmt_create,gmt_modified",
            "ma_channel_binding=gmt_create",
            "ma_delivery=claimed_at,claim_until,available_at,gmt_create,gmt_modified",
            "ma_schedule=armed_at,watermark_slot,lease_until,gmt_create,gmt_modified",
            "ma_schedule_occurrence=slot,next_retry_at,gmt_create,gmt_modified");

    @Test
    void canonicalSchemaUsesCreationAndModificationNamesWithoutLegacyAliases() {
        assertFalse(Pattern.compile("\\b(?:created_at|updated_at)\\b")
                .matcher(ManagedSchema.ddl()).find());
    }

    @Test
    void all77PersistedTimestampsDeclareUnsignedIntegerMilliseconds() {
        Map<String, String> declarations = declarations();
        List<Executable> checks = new ArrayList<>();
        int count = 0;
        for (String table : TIMESTAMPS) {
            String[] parts = table.split("=", 2);
            for (String column : parts[1].split(",")) {
                count++;
                String key = parts[0] + "." + column;
                checks.add(() -> {
                    String declaration = declarations.get(key);
                    assertNotNull(declaration, "Missing timestamp column: " + key);
                    assertTrue(declaration.matches("BIGINT UNSIGNED(?:[ ,].*)?"),
                            () -> key + " must store unsigned epoch milliseconds: " + declaration);
                });
            }
        }
        assertEquals(77, count);
        assertAll(checks);
    }

    @Test
    void canonicalSchemaHasNoPersistedDatetimeOrTimestampColumns() {
        assertFalse(Pattern.compile("(?m)^    [a-z_]+ (?:DATETIME|TIMESTAMP)\\b")
                .matcher(ManagedSchema.ddl()).find());
    }

    @Test
    void writerLeaseRoundTripsNullZeroAndPost2038EpochMilliseconds() throws Exception {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:time-contract-" + UUID.randomUUID()
                + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1");
        ManagedSchema.initialize(source);
        long epochMillis = 2_208_988_800_123L;
        try (var connection = source.getConnection(); var statement = connection.createStatement()) {
            try (var columns = statement.executeQuery(
                    "SELECT writer_lease_until FROM ma_session_head LIMIT 0")) {
                assertEquals(Types.BIGINT, columns.getMetaData().getColumnType(1));
            }
            try (var insert = connection.prepareStatement(
                    "INSERT INTO ma_session_head (tenant_key,harness_key,tenant_id,session_id,"
                            + "harness_session_id,head_kind,gmt_create,gmt_modified,o3_backfill_pending)"
                            + " VALUES ('tenant','harness',?,?,?,'HARNESS',?,?,FALSE)")) {
                insert.setBytes(1, ManagedSchemaKeys.identity("tenant"));
                insert.setBytes(2, ManagedSchemaKeys.identity("harness"));
                insert.setBytes(3, ManagedSchemaKeys.identity("harness"));
                insert.setLong(4, epochMillis);
                insert.setLong(5, epochMillis);
                assertEquals(1, insert.executeUpdate());
            }
            for (Long expected : Arrays.asList(null, 0L, epochMillis)) {
                try (var update = connection.prepareStatement(
                        "UPDATE ma_session_head SET writer_lease_until = ?")) {
                    if (expected == null) {
                        update.setNull(1, Types.BIGINT);
                    } else {
                        update.setLong(1, expected);
                    }
                    assertEquals(1, update.executeUpdate());
                }
                try (var result = statement.executeQuery(
                        "SELECT writer_lease_until,gmt_create,gmt_modified FROM ma_session_head")) {
                    assertTrue(result.next());
                    var row = ManagedSchemaRows.read(result);
                    assertEquals(expected, row.get("writer_lease_until"));
                    assertEquals(epochMillis, row.get("gmt_create"));
                    assertEquals(epochMillis, row.get("gmt_modified"));
                }
            }
        }
    }

    private static Map<String, String> declarations() {
        Map<String, String> declarations = new LinkedHashMap<>();
        var tables = Pattern.compile("CREATE TABLE (ma_[a-z_]+) \\((.*?)\\) ENGINE=InnoDB",
                Pattern.DOTALL).matcher(ManagedSchema.ddl());
        while (tables.find()) {
            var columns = Pattern.compile("(?m)^    ([a-z0-9_]+) ([^\\n]+)")
                    .matcher(tables.group(2));
            while (columns.find()) {
                declarations.put(tables.group(1) + "." + columns.group(1), columns.group(2));
            }
        }
        return declarations;
    }
}
