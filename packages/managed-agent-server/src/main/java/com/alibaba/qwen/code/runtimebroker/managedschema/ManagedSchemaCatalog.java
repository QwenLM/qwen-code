package com.alibaba.qwen.code.runtimebroker.managedschema;

import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/** Catalog validation derived from the one canonical DDL resource. */
final class ManagedSchemaCatalog {
    private static final Pattern TABLE =
            Pattern.compile("CREATE TABLE (ma_[a-z_]+) \\((.*?)\\) ENGINE=InnoDB", Pattern.DOTALL);
    private static final Pattern COLUMN =
            Pattern.compile(
                    "(?m)^    ([a-z0-9_]+)"
                        + " (VARBINARY|VARCHAR|CHAR|BIGINT|INT|BOOLEAN|DATETIME|LONGTEXT|MEDIUMTEXT|MEDIUMBLOB|LONGBLOB)(?:\\((\\d+)\\))?([^\\n"
                        + "]*)");
    private static final Pattern PRIMARY = Pattern.compile("PRIMARY KEY \\(([^)]+)\\)");
    private static final Pattern UNIQUE = Pattern.compile("UNIQUE(?: KEY [a-z_]+)? \\(([^)]+)\\)");
    private static final Pattern CHECK = Pattern.compile("CONSTRAINT ([a-z_]+) CHECK");
    private static final Pattern INDEX =
            Pattern.compile("CREATE (UNIQUE )?INDEX ([a-z_]+) ON (ma_[a-z_]+) \\(([^)]+)\\)");
    private static final Pattern INLINE_INDEX = Pattern.compile("INDEX ([a-z_]+)\\s*\\(([^)]+)\\)");
    private static final Pattern FOREIGN =
            Pattern.compile("FOREIGN KEY \\(([^)]+)\\)\\s*REFERENCES (ma_[a-z_]+) \\(([^)]+)\\)");

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
                    "Managed schema must contain exactly the 32 target tables: " + actual.keySet());
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
        var table = TABLE.matcher(ddl);
        Set<String> declared = new HashSet<>();
        while (table.find()) {
            String name = table.group(1);
            declared.add(name);
            String body = table.group(2);
            validateColumns(connection, name, body);
            validateGeneratedColumns(connection, name, body);
            validateKeys(connection, name, body, ddl);
            validateChecks(connection, name, body);
            validateForeignKeys(connection, name, body, ddl);
        }
        if (!declared.equals(ManagedSchemaContract.TABLES)) {
            throw new SQLException(
                    "Canonical DDL table declarations differ from the target contract");
        }
    }

    private static void validateColumns(Connection connection, String name, String body)
            throws SQLException {
        Map<String, Integer> actual = new HashMap<>();
        Map<String, Integer> types = new HashMap<>();
        Map<String, Boolean> unsigned = new HashMap<>();
        Map<String, String> names = new HashMap<>();
        Map<String, Boolean> required = new HashMap<>();
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
                        unsigned.put(lower(result.getString(1)), lower(result.getString(2)).contains("unsigned"));
                    }
                }
            }
        }
        Set<String> expected = new HashSet<>();
        Set<String> primaryColumns = new HashSet<>();
        var primary = PRIMARY.matcher(body);
        if (primary.find()) {
            primaryColumns.addAll(columns(primary.group(1)));
        }
        var column = COLUMN.matcher(body);
        while (column.find()) {
            String key = column.group(1);
            if (!expected.add(key)) {
                throw new SQLException("Canonical DDL repeats a column: " + name + "." + key);
            }
            if (!actual.containsKey(key)) {
                throw new SQLException("Managed schema column is missing: " + name + "." + key);
            }
            if (!compatibleType(column.group(2), types.get(key))) {
                throw new SQLException("Managed schema column type differs: " + name + "." + key);
            }
            if (nativeDatabase && "BIGINT".equals(column.group(2))
                    && column.group(4).contains("UNSIGNED") != Boolean.TRUE.equals(unsigned.get(key))) {
                throw new SQLException("Managed schema integer signedness differs: " + name + "." + key);
            }
            if (Set.of("LONGTEXT", "MEDIUMTEXT", "MEDIUMBLOB", "LONGBLOB").contains(column.group(2))
                    && actual.get(key) < 1_048_576) {
                throw new SQLException("Managed schema body capacity differs: " + name + "." + key);
            }
            if ("MySQL".equals(connection.getMetaData().getDatabaseProductName())
                    && Set.of("LONGTEXT", "MEDIUMTEXT", "MEDIUMBLOB", "LONGBLOB")
                            .contains(column.group(2))
                    && !column.group(2).equalsIgnoreCase(names.get(key))) {
                throw new SQLException(
                        "Managed schema body storage type differs: " + name + "." + key);
            }
            boolean requiredByModel =
                    column.group(4).stripLeading().replaceFirst("^UNSIGNED\\s+", "").startsWith("NOT NULL")
                            || column.group(4).contains("PRIMARY KEY")
                            || primaryColumns.contains(key);
            if (requiredByModel != required.get(key)) {
                throw new SQLException(
                        "Managed schema column nullability differs: " + name + "." + key);
            }
            if (column.group(3) != null
                    && Set.of("VARBINARY", "VARCHAR", "CHAR").contains(column.group(2))
                    && actual.get(key) != Integer.parseInt(column.group(3))) {
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

    private static void validateKeys(Connection connection, String name, String body, String ddl)
            throws SQLException {
        DatabaseMetaData metadata = connection.getMetaData();
        List<String> primary = new ArrayList<>();
        var declaration = PRIMARY.matcher(body);
        if (declaration.find()) {
            primary = columns(declaration.group(1));
        } else {
            var inline = COLUMN.matcher(body);
            while (inline.find()) {
                if (inline.group(4).contains("PRIMARY KEY")) {
                    primary.add(inline.group(1));
                }
            }
        }
        Map<Integer, String> actualPrimary = new java.util.TreeMap<>();
        try (var result =
                metadata.getPrimaryKeys(
                        connection.getCatalog(),
                        connection.getSchema(),
                        storedName(connection, name))) {
            while (result.next()) {
                actualPrimary.put(result.getInt("KEY_SEQ"), lower(result.getString("COLUMN_NAME")));
            }
        }
        if (!new ArrayList<>(actualPrimary.values()).equals(primary)) {
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
                    indexes.computeIfAbsent(lower(index), ignored -> new java.util.TreeMap<>())
                            .put(result.getInt("ORDINAL_POSITION"), lower(column));
                    if (!result.getBoolean("NON_UNIQUE")) {
                        uniqueIndexes.add(lower(index));
                    }
                }
            }
        }
        var unique = UNIQUE.matcher(body);
        while (unique.find()) {
            List<String> required = columns(unique.group(1));
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
        var index = INDEX.matcher(ddl);
        while (index.find()) {
            if (name.equals(index.group(3))) {
                var actual = indexes.get(index.group(2));
                if (actual == null
                        || !new ArrayList<>(actual.values()).equals(columns(index.group(4)))
                        || index.group(1) != null && !uniqueIndexes.contains(index.group(2))) {
                    throw new SQLException("Managed schema index differs: " + index.group(2));
                }
            }
        }
        var inline = INLINE_INDEX.matcher(body);
        while (inline.find()) {
            var actual = indexes.get(inline.group(1));
            if (actual == null
                    || !new ArrayList<>(actual.values()).equals(columns(inline.group(2)))) {
                throw new SQLException("Managed schema index differs: " + inline.group(1));
            }
        }
    }

    private static void validateForeignKeys(
            Connection connection, String name, String body, String ddl) throws SQLException {
        Map<String, Map<Integer, String>> actual = new HashMap<>();
        try (var result =
                connection
                        .getMetaData()
                        .getImportedKeys(
                                connection.getCatalog(),
                                connection.getSchema(),
                                storedName(connection, name))) {
            while (result.next()) {
                String key = lower(result.getString("FK_NAME"));
                actual.computeIfAbsent(key, ignored -> new java.util.TreeMap<>())
                        .put(
                                result.getInt("KEY_SEQ"),
                                lower(result.getString("FKCOLUMN_NAME"))
                                        + ":"
                                        + lower(result.getString("PKTABLE_NAME"))
                                        + ":"
                                        + lower(result.getString("PKCOLUMN_NAME")));
            }
        }
        var alters = Pattern.compile("ALTER TABLE " + name + " ([^;]+);").matcher(ddl);
        String declarations = body;
        while (alters.find()) {
            declarations += "\n" + alters.group(1);
        }
        var foreign = FOREIGN.matcher(declarations);
        while (foreign.find()) {
            List<String> local = columns(foreign.group(1));
            List<String> remote = columns(foreign.group(3));
            List<String> expected = new ArrayList<>();
            for (int index = 0; index < local.size(); index++) {
                expected.add(local.get(index) + ":" + foreign.group(2) + ":" + remote.get(index));
            }
            if (actual.values().stream()
                    .noneMatch(key -> new ArrayList<>(key.values()).equals(expected))) {
                throw new SQLException("Managed schema foreign key is missing: " + name + local);
            }
        }
    }

    private static boolean compatibleType(String declaration, int type) {
        return switch (declaration) {
            case "VARBINARY" -> type == java.sql.Types.VARBINARY;
            case "VARCHAR" -> type == java.sql.Types.VARCHAR;
            case "CHAR" -> type == java.sql.Types.CHAR;
            case "BIGINT" -> type == java.sql.Types.BIGINT;
            case "INT" -> type == java.sql.Types.INTEGER;
            case "BOOLEAN" ->
                    type == java.sql.Types.BOOLEAN
                            || type == java.sql.Types.BIT
                            || type == java.sql.Types.TINYINT;
            case "DATETIME" -> type == java.sql.Types.TIMESTAMP;
            case "LONGTEXT", "MEDIUMTEXT" ->
                    type == java.sql.Types.LONGVARCHAR
                            || type == java.sql.Types.CLOB
                            || type == java.sql.Types.VARCHAR;
            case "MEDIUMBLOB", "LONGBLOB" ->
                    type == java.sql.Types.LONGVARBINARY
                            || type == java.sql.Types.BLOB
                            || type == java.sql.Types.VARBINARY;
            default -> false;
        };
    }

    static void validateGeneratedColumns(Connection connection, String name, String body)
            throws SQLException {
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
        var column = COLUMN.matcher(body);
        while (column.find()) {
            int generated = column.group(4).indexOf("GENERATED ALWAYS AS");
            if (generated < 0) {
                continue;
            }
            String expression =
                    column.group(4).substring(generated + "GENERATED ALWAYS AS".length());
            String stored = actual.get(column.group(1));
            List<String> expectedTokens = numericBooleans(expressionTokens(expression));
            List<String> actualTokens =
                    stored == null ? List.of() : numericBooleans(expressionTokens(stored));
            boolean same = expectedTokens.equals(actualTokens);
            if (!same && "projection_pending".equals(column.group(1))) {
                int split = expectedTokens.indexOf("or");
                List<String> commuted =
                        new ArrayList<>(expectedTokens.subList(split + 1, expectedTokens.size()));
                commuted.add("or");
                commuted.addAll(expectedTokens.subList(0, split));
                same = commuted.equals(actualTokens);
            }
            if (!same) {
                throw new SQLException(
                        "Managed schema generated column differs: " + name + "." + column.group(1));
            }
        }
    }

    static void validateChecks(Connection connection, String name, String body)
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
        var check = CHECK.matcher(body);
        while (check.find()) {
            String expression = body.substring(check.end()).split("\n", 2)[0];
            String stored = actual.get(check.group(1));
            List<String> expected = expressionTokens(expression);
            boolean compareExpression =
                    !"H2".equals(connection.getMetaData().getDatabaseProductName())
                            || expected.contains("case");
            if (stored == null
                    || compareExpression && !checkShape(expression).equals(checkShape(stored))) {
                throw new SQLException(
                        "Managed schema check differs: "
                                + check.group(1)
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
        var matcher =
                Pattern.compile(
                                "'(?:[^']|'')*'|[a-zA-Z_][a-zA-Z0-9_]*|[0-9]+|>=|<=|<>|!=|[()=+*/<>-]")
                        .matcher(portable);
        List<String> tokens = new ArrayList<>();
        while (matcher.find()) {
            String token = matcher.group();
            tokens.add(token.startsWith("'") ? token : lower(token));
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
        var tokens =
                Pattern.compile(
                                "(?i)x'([0-9a-f]*)'|0x([0-9a-f]+)|'(?:[^']|'')*'|_[a-zA-Z0-9]+(?=')")
                        .matcher(expression.replace("\\'", "'"));
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
        var tokens =
                Pattern.compile(
                                "'(?:[^']|'')*'|[a-zA-Z_][a-zA-Z0-9_]*|[0-9]+|>=|<=|<>|!=|[=+*/<>-]")
                        .matcher(portable);
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

    private static List<String> columns(String value) {
        return java.util.Arrays.stream(value.split(","))
                .map(String::trim)
                .map(ManagedSchemaCatalog::lower)
                .toList();
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
