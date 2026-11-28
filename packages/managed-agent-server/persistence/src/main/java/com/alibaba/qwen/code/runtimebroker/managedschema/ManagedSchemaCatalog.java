package com.alibaba.qwen.code.runtimebroker.managedschema;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaDdlParser.CheckSpec;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaDdlParser.ColumnSpec;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaDdlParser.IndexSpec;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaDdlParser.ParsedDdl;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaDdlParser.TableSpec;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaContract;

import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.SQLException;
import java.sql.Types;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeMap;
import java.util.regex.Pattern;

/** Catalog validation derived from the one canonical DDL resource. */
final class ManagedSchemaCatalog {
    private static final Pattern SHAPE_TOKEN = Pattern.compile(
            "'(?:[^']|'')*'|[a-zA-Z_][a-zA-Z0-9_]*|[0-9]+|>=|<=|<>|!=|[()=+*/<>-]");
    private static final Pattern EXPRESSION_TOKEN = Pattern.compile(
            "'(?:[^']|'')*'|[a-zA-Z_][a-zA-Z0-9_]*|[0-9]+|>=|<=|<>|!=|[=+*/<>-]");
    private static final Pattern PORTABLE_LITERAL = Pattern.compile(
            "(?i)x'([0-9a-f]*)'|0x([0-9a-f]+)|'(?:[^']|'')*'|_[a-zA-Z0-9]+(?=')");

    private ManagedSchemaCatalog() {}

    static void requireApplicationCatalog(Connection connection) throws SQLException {
        String product = connection.getMetaData().getDatabaseProductName();
        if ("MySQL".equals(product) || "MariaDB".equals(product)) {
            String name = connection.getCatalog();
            if (name == null || name.isBlank()
                    || Set.of("mysql", "sys", "information_schema", "performance_schema")
                            .contains(lower(name))) {
                throw new SQLException("Managed schema requires a dedicated application catalog;"
                        + " system or missing catalog refused before DDL: " + name);
            }
            try (var statement = connection.prepareStatement("SELECT @@SESSION.sql_mode");
                    var result = statement.executeQuery()) {
                if (!result.next() || !strictSqlMode(result.getString(1))) {
                    throw new SQLException("Managed schema requires strict SQL mode"
                            + " (STRICT_TRANS_TABLES or STRICT_ALL_TABLES) for the current session;"
                            + " refused before DDL");
                }
            }
            if (isMariaDb(connection)) {
                try (var statement = connection.prepareStatement(
                        "SELECT @@GLOBAL.check_constraint_checks, @@SESSION.check_constraint_checks");
                        var result = statement.executeQuery()) {
                    if (!result.next() || result.getInt(1) != 1 || result.getInt(2) != 1) {
                        throw new SQLException("Managed schema requires MariaDB CHECK enforcement"
                                + " globally and for the current session; refused before DDL");
                    }
                }
            }
        }
    }

    private static boolean strictSqlMode(String modes) {
        for (String mode : modes.split(",")) {
            if ("STRICT_TRANS_TABLES".equalsIgnoreCase(mode.trim())
                    || "STRICT_ALL_TABLES".equalsIgnoreCase(mode.trim())) {
                return true;
            }
        }
        return false;
    }

    private static boolean isMariaDb(Connection connection) throws SQLException {
        var metadata = connection.getMetaData();
        String version = metadata.getDatabaseProductVersion();
        return "MariaDB".equals(metadata.getDatabaseProductName())
                || version != null && lower(version).contains("mariadb");
    }

    static Map<String, String> tables(Connection connection) throws SQLException {
        requireApplicationCatalog(connection);
        Map<String, String> tables = new LinkedHashMap<>();
        try (var result =
                connection
                        .getMetaData()
                        .getTables(
                                connection.getCatalog(),
                                connection.getSchema(),
                                "%",
                                new String[] {"TABLE", "VIEW"})) {
            while (result.next()) {
                tables.put(lower(result.getString("TABLE_NAME")), result.getString("TABLE_TYPE"));
            }
        }
        String history = tables.remove("flyway_schema_history");
        if (history != null && history.toUpperCase(Locale.ROOT).contains("VIEW")) {
            throw new SQLException("Flyway history must be a table");
        }
        return tables;
    }

    static boolean hasHistory(Connection connection) throws SQLException {
        try (var rows =
                connection
                        .getMetaData()
                        .getTables(
                                connection.getCatalog(),
                                connection.getSchema(),
                                storedName(connection, "flyway_schema_history"),
                                new String[] {"TABLE", "VIEW"})) {
            return rows.next();
        }
    }

    static void validate(Connection connection, String ddl) throws SQLException {
        Map<String, String> actual = tables(connection);
        if (!actual.keySet().equals(ManagedSchemaContract.TABLES)
                || actual.values().stream()
                        .anyMatch(type -> type.toUpperCase(Locale.ROOT).contains("VIEW"))) {
            throw new SQLException(
                    "Managed schema must contain exactly the " + ManagedSchemaContract.TABLES.size()
                            + " target tables: " + actual.keySet());
        }
        if ("MySQL".equals(connection.getMetaData().getDatabaseProductName())
                || isMariaDb(connection)) {
            try (var statement =
                    connection.prepareStatement(
                            "SELECT TABLE_NAME, ENGINE FROM INFORMATION_SCHEMA.TABLES WHERE"
                                    + " TABLE_SCHEMA = ?")) {
                statement.setString(1, schema(connection));
                try (var result = statement.executeQuery()) {
                    while (result.next()) {
                        if (ManagedSchemaContract.TABLES.contains(lower(result.getString(1)))
                                && !"InnoDB".equals(result.getString(2))) {
                            throw new SQLException(
                                    "Managed schema requires InnoDB: " + result.getString(1));
                        }
                    }
                }
            }
        }
        ParsedDdl parsed = ManagedSchemaDdlParser.parse(ddl);
        if (!parsed.tables().keySet().equals(ManagedSchemaContract.TABLES)) {
            throw new SQLException(
                    "Canonical DDL table declarations differ from the target contract");
        }
        Map<String, List<IndexSpec>> externalIndexes = new HashMap<>();
        for (IndexSpec index : parsed.indexes()) {
            externalIndexes.computeIfAbsent(index.table(), ignored -> new ArrayList<>()).add(index);
        }
        for (TableSpec table : parsed.tables().values()) {
            validateColumns(connection, table);
            validateGeneratedColumns(connection, table.name(), table.columns());
            validateKeys(connection, table, externalIndexes.getOrDefault(table.name(), List.of()));
            validateChecks(connection, table.name(), table.checks());
            validateForeignKeys(connection, table.name());
        }
    }

    private static void validateColumns(Connection connection, TableSpec table)
            throws SQLException {
        String name = table.name();
        Map<String, Integer> actual = new HashMap<>();
        Map<String, Integer> types = new HashMap<>();
        Map<String, Boolean> unsigned = new HashMap<>();
        Map<String, String> names = new HashMap<>();
        Map<String, Boolean> required = new HashMap<>();
        Map<String, Boolean> automatic = new HashMap<>();
        try (var result =
                connection
                        .getMetaData()
                        .getColumns(
                                connection.getCatalog(),
                                connection.getSchema(),
                                storedName(connection, name),
                                "%")) {
            while (result.next()) {
                actual.put(lower(result.getString("COLUMN_NAME")), result.getInt("COLUMN_SIZE"));
                types.put(lower(result.getString("COLUMN_NAME")), result.getInt("DATA_TYPE"));
                names.put(lower(result.getString("COLUMN_NAME")), result.getString("TYPE_NAME"));
                required.put(
                        lower(result.getString("COLUMN_NAME")),
                        result.getInt("NULLABLE") == DatabaseMetaData.columnNoNulls);
                automatic.put(lower(result.getString("COLUMN_NAME")),
                        "YES".equals(result.getString("IS_AUTOINCREMENT")));
            }
        }
        boolean nativeDatabase = "MySQL".equals(connection.getMetaData().getDatabaseProductName())
                || isMariaDb(connection);
        if (nativeDatabase) {
            try (var statement =
                    connection.prepareStatement(
                            "SELECT COLUMN_NAME,COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS"
                                    + " WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?")) {
                statement.setString(1, schema(connection));
                statement.setString(2, name);
                try (var result = statement.executeQuery()) {
                    while (result.next()) {
                        unsigned.put(
                                lower(result.getString(1)),
                                lower(result.getString(2)).contains("unsigned"));
                    }
                }
            }
        }
        Set<String> expected = new HashSet<>();
        Set<String> primaryColumns = new HashSet<>(table.primaryKey());
        for (ColumnSpec column : table.columns()) {
            String key = column.name();
            if (!expected.add(key)) {
                throw new SQLException("Canonical DDL repeats a column: " + name + "." + key);
            }
            if (!actual.containsKey(key)) {
                throw new SQLException("Managed schema column is missing: " + name + "." + key);
            }
            if (!compatibleType(column.type(), types.get(key))) {
                throw new SQLException("Managed schema column type differs: " + name + "." + key);
            }
            if (nativeDatabase && Set.of("BIGINT", "INT", "TINYINT").contains(column.type())
                    && column.unsigned() != Boolean.TRUE.equals(unsigned.get(key))) {
                throw new SQLException(
                        "Managed schema integer signedness differs: " + name + "." + key);
            }
            if (column.autoIncrement() != Boolean.TRUE.equals(automatic.get(key))) {
                throw new SQLException(
                        "Managed schema identity generation differs: " + name + "." + key);
            }
            if (Set.of("LONGTEXT", "MEDIUMTEXT", "MEDIUMBLOB", "LONGBLOB").contains(column.type())
                    && actual.get(key) < 1_048_576) {
                throw new SQLException("Managed schema body capacity differs: " + name + "." + key);
            }
            if ("MySQL".equals(connection.getMetaData().getDatabaseProductName())
                    && Set.of("LONGTEXT", "MEDIUMTEXT", "MEDIUMBLOB", "LONGBLOB")
                            .contains(column.type())
                    && !column.type().equalsIgnoreCase(names.get(key))) {
                throw new SQLException(
                        "Managed schema body storage type differs: " + name + "." + key);
            }
            boolean requiredByModel =
                    column.notNull() || column.inlinePrimaryKey() || primaryColumns.contains(key);
            if (requiredByModel != Boolean.TRUE.equals(required.get(key))) {
                throw new SQLException(
                        "Managed schema column nullability differs: " + name + "." + key);
            }
            if (column.length() != null
                    && Set.of("VARBINARY", "VARCHAR", "CHAR").contains(column.type())
                    && !actual.get(key).equals(column.length())) {
                throw new SQLException(
                        "Managed schema identity width differs: " + name + "." + key);
            }
        }
        if (!actual.keySet().equals(expected)) {
            throw new SQLException(
                    "Managed schema columns differ: "
                            + name
                            + " expected="
                            + expected
                            + " actual="
                            + actual.keySet());
        }
    }

    private static void validateKeys(
            Connection connection, TableSpec table, List<IndexSpec> externalIndexes)
            throws SQLException {
        String name = table.name();
        DatabaseMetaData metadata = connection.getMetaData();
        Map<Integer, String> actualPrimary = new TreeMap<>();
        try (var result =
                metadata.getPrimaryKeys(
                        connection.getCatalog(),
                        connection.getSchema(),
                        storedName(connection, name))) {
            while (result.next()) {
                actualPrimary.put(result.getInt("KEY_SEQ"), lower(result.getString("COLUMN_NAME")));
            }
        }
        if (!new ArrayList<>(actualPrimary.values()).equals(table.primaryKey())) {
            throw new SQLException("Managed schema primary key differs: " + name);
        }
        Map<String, Map<Integer, String>> indexes = new HashMap<>();
        Set<String> uniqueIndexes = new HashSet<>();
        try (var result =
                metadata.getIndexInfo(
                        connection.getCatalog(),
                        connection.getSchema(),
                        storedName(connection, name),
                        false,
                        false)) {
            while (result.next()) {
                String index = result.getString("INDEX_NAME");
                String column = result.getString("COLUMN_NAME");
                if (index != null && column != null) {
                    indexes.computeIfAbsent(lower(index), ignored -> new TreeMap<>())
                            .put(result.getInt("ORDINAL_POSITION"), lower(column));
                    if (!result.getBoolean("NON_UNIQUE")) {
                        uniqueIndexes.add(lower(index));
                    }
                }
            }
        }
        for (List<String> required : table.uniqueKeys()) {
            boolean found =
                    uniqueIndexes.stream()
                            .anyMatch(
                                    index ->
                                            new ArrayList<>(indexes.get(index).values())
                                                    .equals(required));
            if (!found) {
                throw new SQLException("Managed schema unique key is missing: " + name + required);
            }
        }
        for (IndexSpec index : externalIndexes) {
            var actual = indexes.get(index.name());
            if (actual == null
                    || !new ArrayList<>(actual.values()).equals(index.columns())
                    || index.unique() && !uniqueIndexes.contains(index.name())) {
                throw new SQLException("Managed schema index differs: " + index.name());
            }
            validateIndexPrefix(connection, name, index.name(), index.prefixes());
        }
        for (IndexSpec inline : table.inlineIndexes()) {
            var actual = indexes.get(inline.name());
            if (actual == null || !new ArrayList<>(actual.values()).equals(inline.columns())) {
                throw new SQLException("Managed schema index differs: " + inline.name());
            }
        }
    }

    private static void validateIndexPrefix(
            Connection connection, String table, String index, List<Integer> expectedPrefixes)
            throws SQLException {
        if (!"MySQL".equals(connection.getMetaData().getDatabaseProductName())
                && !isMariaDb(connection)) {
            return;
        }
        try (var statement = connection.prepareStatement(
                "SELECT SEQ_IN_INDEX, SUB_PART FROM INFORMATION_SCHEMA.STATISTICS"
                        + " WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?")) {
            statement.setString(1, schema(connection));
            statement.setString(2, table);
            statement.setString(3, index);
            try (var rows = statement.executeQuery()) {
                while (rows.next()) {
                    Integer expected = expectedPrefixes.get(rows.getInt(1) - 1);
                    if (!Objects.equals(expected, rows.getObject(2, Integer.class))) {
                        throw new SQLException("Managed schema index prefix differs: " + index);
                    }
                }
            }
        }
    }

    private static void validateForeignKeys(Connection connection, String name) throws SQLException {
        try (var keys = connection.getMetaData().getImportedKeys(
                connection.getCatalog(), connection.getSchema(), storedName(connection, name))) {
            if (keys.next()) {
                throw new SQLException("Managed schema must not contain foreign keys: " + name);
            }
        }
    }

    private static boolean compatibleType(String declaration, int type) {
        return switch (declaration) {
            case "VARBINARY" -> type == Types.VARBINARY;
            case "VARCHAR" -> type == Types.VARCHAR;
            case "CHAR" -> type == Types.CHAR;
            case "BIGINT" -> type == Types.BIGINT;
            case "INT" -> type == Types.INTEGER;
            case "TINYINT" -> type == Types.TINYINT;
            case "BOOLEAN" ->
                    type == Types.BOOLEAN
                            || type == Types.BIT
                            || type == Types.TINYINT;
            case "DATETIME" -> type == Types.TIMESTAMP;
            case "LONGTEXT", "MEDIUMTEXT" ->
                    type == Types.LONGVARCHAR
                            || type == Types.CLOB
                            || type == Types.VARCHAR;
            case "MEDIUMBLOB", "LONGBLOB" ->
                    type == Types.LONGVARBINARY
                            || type == Types.BLOB
                            || type == Types.VARBINARY;
            default -> false;
        };
    }

    static void validateGeneratedColumns(Connection connection, String name, String body)
            throws SQLException {
        validateGeneratedColumns(
                connection, name, ManagedSchemaDdlParser.parseTableBody(name, body).columns());
    }

    private static void validateGeneratedColumns(
            Connection connection, String name, List<ColumnSpec> columns) throws SQLException {
        Map<String, String> actual = new HashMap<>();
        try (var statement =
                connection.prepareStatement(
                        "SELECT COLUMN_NAME, GENERATION_EXPRESSION FROM INFORMATION_SCHEMA.COLUMNS"
                                + " WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?")) {
            statement.setString(1, schema(connection));
            statement.setString(2, storedName(connection, name));
            try (var result = statement.executeQuery()) {
                while (result.next()) {
                    actual.put(lower(result.getString(1)), result.getString(2));
                }
            }
        }
        for (ColumnSpec column : columns) {
            if (column.generatedExpression() == null) {
                continue;
            }
            String stored = actual.get(column.name());
            List<String> expectedTokens =
                    numericBooleans(expressionTokens(column.generatedExpression()));
            List<String> actualTokens =
                    stored == null ? List.of() : numericBooleans(expressionTokens(stored));
            if (!expectedTokens.equals(actualTokens)) {
                throw new SQLException(
                        "Managed schema generated column differs: " + name + "." + column.name());
            }
        }
    }

    static void validateChecks(Connection connection, String name, String body)
            throws SQLException {
        validateChecks(connection, name, ManagedSchemaDdlParser.parseTableBody(name, body).checks());
    }

    private static void validateChecks(Connection connection, String name, List<CheckSpec> checks)
            throws SQLException {
        Map<String, String> actual = new HashMap<>();
        String enforcement = isMariaDb(connection) ? "'YES'" : "t.ENFORCED";
        try (var statement =
                connection.prepareStatement(
                        "SELECT t.CONSTRAINT_NAME, c.CHECK_CLAUSE, " + enforcement + " FROM"
                            + " INFORMATION_SCHEMA.TABLE_CONSTRAINTS t JOIN"
                            + " INFORMATION_SCHEMA.CHECK_CONSTRAINTS c ON c.CONSTRAINT_SCHEMA ="
                            + " t.CONSTRAINT_SCHEMA AND c.CONSTRAINT_NAME = t.CONSTRAINT_NAME WHERE"
                            + " t.TABLE_SCHEMA = ? AND t.TABLE_NAME = ? AND t.CONSTRAINT_TYPE ="
                            + " 'CHECK'")) {
            statement.setString(1, schema(connection));
            statement.setString(2, storedName(connection, name));
            try (var result = statement.executeQuery()) {
                while (result.next()) {
                    if ("YES".equalsIgnoreCase(result.getString(3))) {
                        actual.put(lower(result.getString(1)), result.getString(2));
                    }
                }
            }
        }
        for (CheckSpec check : checks) {
            String expression = check.expression();
            String stored = actual.get(check.name());
            List<String> expected = expressionTokens(expression);
            boolean compareExpression =
                    !"H2".equals(connection.getMetaData().getDatabaseProductName())
                            || expected.contains("case");
            if (stored == null
                    || compareExpression && !checkShape(expression).equals(checkShape(stored))) {
                throw new SQLException(
                        "Managed schema check differs: "
                                + name
                                + "."
                                + check.name()
                                + " expected="
                                + expressionTokens(expression)
                                + " actual="
                                + (stored == null ? null : expressionTokens(stored)));
            }
        }
    }

    private static String schema(Connection connection) throws SQLException {
        return connection.getSchema() == null ? connection.getCatalog() : connection.getSchema();
    }

    private static List<String> checkShape(String expression) {
        List<String> flat = expressionTokens(expression);
        if (flat.contains("case")) {
            return flat;
        }
        String portable = portableExpression(expression);
        var matcher = SHAPE_TOKEN.matcher(portable);
        List<String> tokens = new ArrayList<>();
        while (matcher.find()) {
            String token = matcher.group();
            String normalized = token.startsWith("'") ? token : lower(token);
            tokens.add("octet_length".equals(normalized) ? "length" : normalized);
        }
        return booleanShape(numericBooleans(tokens));
    }

    private static List<String> booleanShape(List<String> tokens) {
        while (!tokens.isEmpty() && "(".equals(tokens.getFirst())) {
            int depth = 0;
            int closing = -1;
            for (int index = 0; index < tokens.size(); index++) {
                if ("(".equals(tokens.get(index))) {
                    depth++;
                } else if (")".equals(tokens.get(index)) && --depth == 0) {
                    closing = index;
                    break;
                }
            }
            if (closing != tokens.size() - 1) {
                break;
            }
            tokens = tokens.subList(1, closing);
        }
        for (String operator : List.of("or", "and")) {
            int depth = 0;
            int start = 0;
            List<List<String>> operands = new ArrayList<>();
            for (int index = 0; index < tokens.size(); index++) {
                String token = tokens.get(index);
                if ("(".equals(token)) {
                    depth++;
                } else if (")".equals(token)) {
                    depth--;
                } else if (depth == 0 && operator.equals(token)) {
                    operands.add(booleanShape(tokens.subList(start, index)));
                    start = index + 1;
                }
            }
            if (!operands.isEmpty()) {
                operands.add(booleanShape(tokens.subList(start, tokens.size())));
                List<String> result = new ArrayList<>(List.of("(", operator));
                for (List<String> operand : operands) {
                    if (operand.size() > 3
                            && "(".equals(operand.getFirst())
                            && operator.equals(operand.get(1))) {
                        result.addAll(operand.subList(2, operand.size() - 1));
                    } else {
                        result.addAll(operand);
                        result.add(",");
                    }
                }
                result.add(")");
                return result;
            }
        }
        return tokens.stream().filter(token -> !List.of("(", ")").contains(token)).toList();
    }

    private static String portableExpression(String expression) {
        var tokens = PORTABLE_LITERAL.matcher(expression.replace("\\'", "'"));
        return tokens.replaceAll(
                token -> {
                    if (token.group(1) != null || token.group(2) != null) {
                        return "x'"
                                + lower(token.group(1) == null ? token.group(2) : token.group(1))
                                + "'";
                    }
                    return token.group().startsWith("_") ? "" : token.group();
                });
    }

    private static List<String> expressionTokens(String expression) {
        String portable = portableExpression(expression);
        portable = portable.replaceAll("(?i)CAST\\(([-+]?[0-9]+) AS (?:BIGINT|INTEGER)\\)", "$1");
        var tokens = EXPRESSION_TOKEN.matcher(portable);
        List<String> result = new ArrayList<>();
        while (tokens.find()) {
            String token = tokens.group();
            String normalized = token.startsWith("'") ? token : lower(token);
            result.add(
                    switch (normalized) {
                        case "false" -> "0";
                        case "true" -> "1";
                        default -> normalized;
                    });
        }
        return result;
    }

    // MariaDB stores a bare FALSE/TRUE in a generation expression or check
    // clause as 0/1, while MySQL keeps the keyword, so boolean literals
    // compare numerically.
    private static List<String> numericBooleans(List<String> tokens) {
        return tokens.stream().map(token -> switch (token) {
            case "false" -> "0";
            case "true" -> "1";
            default -> token;
        }).toList();
    }

    private static String storedName(Connection connection, String name) throws SQLException {
        return connection.getMetaData().storesUpperCaseIdentifiers()
                ? name.toUpperCase(Locale.ROOT)
                : name;
    }

    private static String lower(String value) {
        return value.toLowerCase(Locale.ROOT);
    }
}
