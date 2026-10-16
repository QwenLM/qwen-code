package com.alibaba.qwen.code.runtimebroker.managedschema;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;

class ManagedSchemaProjectionTest {
    @Test
    void declaresEveryExistingColumnWithoutSelectingFutureSchemaAdditions() throws Exception {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:explicit-projections-" + UUID.randomUUID() + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1");
        ManagedSchema.initialize(source);
        try (var connection = source.getConnection(); var statement = connection.createStatement()) {
            for (ManagedSchemaProjection projection : ManagedSchemaProjection.values()) {
                String table = "ma_" + projection.name().toLowerCase(Locale.ROOT);
                List<String> existing = new ArrayList<>();
                try (var columns = connection.getMetaData().getColumns(null, null, table, null)) {
                    while (columns.next()) {
                        existing.add(columns.getString("COLUMN_NAME"));
                    }
                }
                assertEquals(existing, List.of(projection.columns().split(", ")), table);
                statement.execute("ALTER TABLE " + table + " ADD COLUMN future_column INT");
                try (var result = statement.executeQuery("SELECT " + projection.columns("t")
                        + " FROM " + table + " t WHERE 1 = 0")) {
                    var metadata = result.getMetaData();
                    List<String> selected = new ArrayList<>();
                    for (int index = 1; index <= metadata.getColumnCount(); index++) {
                        selected.add(metadata.getColumnLabel(index));
                    }
                    assertEquals(existing, selected, table);
                    assertFalse(selected.contains("future_column"));
                }
            }
        }
    }
}
