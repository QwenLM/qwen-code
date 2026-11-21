package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.managedagent.persistence.IsolatedManagedSchemaMySqlTestDatabase;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import org.junit.jupiter.api.Test;

import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Real-MySQL gate for the managed identity VARCHAR budgets and NO PAD collation. */
class ManagedSchemaIdentityColumnsMySqlIT {
    @Test
    void tenantAndSessionIdentityColumnsUseTheApprovedVarcharBudgets() throws Exception {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase()) {
            ManagedSchema.initialize(database.source());
            List<String> violations = new ArrayList<>();
            try (var connection = database.source().getConnection();
                    var query = connection.prepareStatement(
                            "SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH,"
                                    + " COLLATION_NAME FROM information_schema.COLUMNS"
                                    + " WHERE TABLE_SCHEMA = ? AND TABLE_NAME LIKE 'ma\\_%'"
                                    + " AND (COLUMN_NAME = 'tenant_id' OR COLUMN_NAME LIKE '%session\\_id')"
                                    + " ORDER BY TABLE_NAME, COLUMN_NAME")) {
                query.setString(1, connection.getCatalog());
                try (var rows = query.executeQuery()) {
                    while (rows.next()) {
                        String table = rows.getString("TABLE_NAME");
                        String column = rows.getString("COLUMN_NAME");
                        String type = rows.getString("DATA_TYPE");
                        long length = rows.getLong("CHARACTER_MAXIMUM_LENGTH");
                        String collation = rows.getString("COLLATION_NAME");
                        long expected = "tenant_id".equals(column)
                                ? ("ma_tenant_guard".equals(table) ? 96 : 36)
                                : 64;
                        if (!"varchar".equalsIgnoreCase(type) || length != expected
                                || !"utf8mb4_0900_bin".equalsIgnoreCase(collation)) {
                            violations.add(table + "." + column + " " + type + "(" + length
                                    + ") " + collation);
                        }
                    }
                }
            }
            assertTrue(violations.isEmpty(), () -> "identity column drift: " + violations);
        }
    }

    @Test
    void everyIndexStaysWithinTheInnoDbKeyBudget() throws Exception {
        try (var database = new IsolatedManagedSchemaMySqlTestDatabase()) {
            ManagedSchema.initialize(database.source());
            List<String> violations = new ArrayList<>();
            try (var connection = database.source().getConnection();
                    var query = connection.prepareStatement(
                            "SELECT s.TABLE_NAME, s.INDEX_NAME, s.SEQ_IN_INDEX, s.COLUMN_NAME,"
                                    + " s.SUB_PART, c.DATA_TYPE, c.CHARACTER_MAXIMUM_LENGTH,"
                                    + " c.CHARACTER_OCTET_LENGTH"
                                    + " FROM information_schema.STATISTICS s"
                                    + " JOIN information_schema.COLUMNS c"
                                    + " ON c.TABLE_SCHEMA = s.TABLE_SCHEMA"
                                    + " AND c.TABLE_NAME = s.TABLE_NAME"
                                    + " AND c.COLUMN_NAME = s.COLUMN_NAME"
                                    + " WHERE s.TABLE_SCHEMA = ? AND s.TABLE_NAME LIKE 'ma\\_%'"
                                    + " ORDER BY s.TABLE_NAME, s.INDEX_NAME, s.SEQ_IN_INDEX")) {
                query.setString(1, connection.getCatalog());
                String currentKey = null;
                long bytes = 0;
                try (var rows = query.executeQuery()) {
                    while (rows.next()) {
                        String key = rows.getString("TABLE_NAME") + "." + rows.getString("INDEX_NAME");
                        if (!key.equals(currentKey)) {
                            checkBudget(violations, currentKey, bytes);
                            currentKey = key;
                            bytes = 0;
                        }
                        bytes += columnBytes(rows.getString("DATA_TYPE"),
                                rows.getObject("SUB_PART") == null ? null : rows.getLong("SUB_PART"),
                                rows.getObject("CHARACTER_MAXIMUM_LENGTH") == null
                                        ? null : rows.getLong("CHARACTER_MAXIMUM_LENGTH"),
                                rows.getObject("CHARACTER_OCTET_LENGTH") == null
                                        ? null : rows.getLong("CHARACTER_OCTET_LENGTH"));
                    }
                }
                checkBudget(violations, currentKey, bytes);
            }
            assertTrue(violations.isEmpty(), () -> "index key budget drift: " + violations);
        }
    }

    private static void checkBudget(List<String> violations, String key, long bytes) {
        if (key != null && bytes > 3072) {
            violations.add(key + "=" + bytes);
        }
    }

    private static long columnBytes(String dataType, Long subPart, Long charLength, Long octetLength)
            throws SQLException {
        String type = dataType.toLowerCase();
        if (subPart != null) {
            if (charLength != null && octetLength != null && charLength > 0) {
                return subPart * (octetLength / charLength);
            }
            return subPart;
        }
        if (charLength != null && octetLength != null) {
            return octetLength;
        }
        return switch (type) {
            case "tinyint" -> 1;
            case "smallint" -> 2;
            case "mediumint" -> 3;
            case "int", "integer" -> 4;
            case "bigint" -> 8;
            case "float" -> 4;
            case "double", "decimal", "numeric" -> 8;
            case "date" -> 3;
            case "datetime", "timestamp" -> 8;
            case "time" -> 3;
            case "year" -> 1;
            case "char", "varchar", "binary", "varbinary", "text", "mediumtext", "longtext",
                    "blob", "mediumblob", "longblob" -> octetLength == null ? 0 : octetLength;
            default -> 0;
        };
    }
}
