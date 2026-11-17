package com.alibaba.qwen.code.runtimebroker.managedschema;

import java.sql.SQLException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Quote-, comment-, and parenthesis-aware parser for {@code V1__managed_schema.sql}
 * that does not depend on indentation or line wrapping.
 */
final class ManagedSchemaDdlParser {
    private static final Set<String> SUPPORTED_TYPES = Set.of(
            "VARBINARY", "VARCHAR", "CHAR", "BIGINT", "INT", "TINYINT",
            "BOOLEAN", "DATETIME", "LONGTEXT", "MEDIUMTEXT", "MEDIUMBLOB", "LONGBLOB");
    private static final Pattern INDEX_PREFIX =
            Pattern.compile("/\\*!50000\\s*\\((\\d+)\\)\\s*\\*/");
    private static final Pattern IDENTIFIER_HEAD =
            Pattern.compile("^`?([a-zA-Z_][a-zA-Z0-9_]*)`?(.*)$", Pattern.DOTALL);

    private ManagedSchemaDdlParser() {}

    record ParsedDdl(Map<String, TableSpec> tables, List<IndexSpec> indexes) {}

    record TableSpec(
            String name,
            List<ColumnSpec> columns,
            List<String> primaryKey,
            List<List<String>> uniqueKeys,
            List<IndexSpec> inlineIndexes,
            List<CheckSpec> checks) {}

    record ColumnSpec(
            String name,
            String type,
            Integer length,
            boolean unsigned,
            boolean autoIncrement,
            boolean notNull,
            boolean inlinePrimaryKey,
            String generatedExpression) {}

    record IndexSpec(
            String name,
            String table,
            boolean unique,
            List<String> columns,
            List<Integer> prefixes) {}

    record CheckSpec(String name, String expression) {}

    static List<String> splitStatements(String sql) throws SQLException {
        return splitTopLevel(sql, ';');
    }

    static ParsedDdl parse(String ddl) throws SQLException {
        Map<String, TableSpec> tables = new LinkedHashMap<>();
        List<IndexSpec> indexes = new ArrayList<>();
        for (String raw : splitStatements(ddl)) {
            String stmt = stripCommentsPreserveHints(raw).trim();
            if (stmt.isEmpty()) {
                continue;
            }
            List<Token> head = scanTokens(stmt, 6);
            if (head.size() >= 3
                    && eq(head.get(0), "CREATE")
                    && eq(head.get(1), "TABLE")) {
                TableSpec table = parseCreateTable(stmt, head);
                if (tables.put(table.name(), table) != null) {
                    throw new SQLException("Canonical DDL repeats table: " + table.name());
                }
            } else if (head.size() >= 5
                    && eq(head.get(0), "CREATE")
                    && (eq(head.get(1), "INDEX")
                            || (eq(head.get(1), "UNIQUE") && eq(head.get(2), "INDEX")))) {
                indexes.add(parseCreateIndex(stmt, head));
            } else {
                throw new SQLException("Unsupported statement in canonical Managed DDL: " + stmt);
            }
        }
        return new ParsedDdl(tables, indexes);
    }

    static TableSpec parseTableBody(String tableName, String body) throws SQLException {
        List<ColumnSpec> columns = new ArrayList<>();
        List<String> primaryKey = new ArrayList<>();
        List<List<String>> uniqueKeys = new ArrayList<>();
        List<IndexSpec> inlineIndexes = new ArrayList<>();
        List<CheckSpec> checks = new ArrayList<>();

        for (String rawEntry : splitTopLevel(body, ',')) {
            String entry = stripCommentsPreserveHints(rawEntry).trim();
            if (entry.isEmpty()) {
                continue;
            }
            List<Token> tokens = scanTokens(entry, Integer.MAX_VALUE);
            if (tokens.isEmpty()) {
                continue;
            }
            String first = upper(tokens.get(0).text());
            if ("CONSTRAINT".equals(first)) {
                parseConstraintClause(tableName, entry, tokens, primaryKey, uniqueKeys, checks);
            } else if ("PRIMARY".equals(first)) {
                requireToken(tokens, 1, "KEY", entry);
                primaryKey.addAll(
                        parseIndexFields(findParenGroupAfter(entry, tokens.get(1).end()).content()).columns());
            } else if ("UNIQUE".equals(first)) {
                int idx = 1;
                if (idx < tokens.size() && (eq(tokens.get(idx), "KEY") || eq(tokens.get(idx), "INDEX"))) {
                    idx++;
                }
                if (idx < tokens.size() && tokens.get(idx).kind() == TokenKind.WORD) {
                    idx++;
                }
                int afterPos = idx > 0 ? tokens.get(idx - 1).end() : tokens.get(0).end();
                uniqueKeys.add(parseIndexFields(findParenGroupAfter(entry, afterPos).content()).columns());
            } else if ("INDEX".equals(first) || "KEY".equals(first)) {
                if (tokens.size() < 2 || tokens.get(1).kind() != TokenKind.WORD) {
                    throw new SQLException("Malformed inline INDEX in " + tableName + ": " + entry);
                }
                String indexName = lower(unquote(tokens.get(1).text()));
                IndexFields fields =
                        parseIndexFields(findParenGroupAfter(entry, tokens.get(1).end()).content());
                inlineIndexes.add(new IndexSpec(indexName, tableName, false, fields.columns(), fields.prefixes()));
            } else if ("CHECK".equals(first)) {
                checks.add(new CheckSpec("", parenGroupAfter(entry, tokens.get(0).end())));
            } else {
                ColumnSpec col = parseColumn(tableName, entry, tokens);
                columns.add(col);
                if (col.inlinePrimaryKey() && primaryKey.isEmpty()) {
                    primaryKey.add(col.name());
                }
            }
        }
        return new TableSpec(tableName, columns, primaryKey, uniqueKeys, inlineIndexes, checks);
    }

    private static TableSpec parseCreateTable(String stmt, List<Token> head) throws SQLException {
        int nameIdx = 2;
        if (head.size() >= 6
                && eq(head.get(2), "IF")
                && eq(head.get(3), "NOT")
                && eq(head.get(4), "EXISTS")) {
            nameIdx = 5;
        }
        String tableName = lower(unquote(head.get(nameIdx).text()));
        ParenSlice slice = findParenGroupAfter(stmt, head.get(nameIdx).end());
        String trailer = stmt.substring(slice.closeIndex() + 1);
        List<Token> trailerTokens = scanTokens(trailer, Integer.MAX_VALUE);
        boolean innoDb = false;
        for (int i = 0; i + 2 < trailerTokens.size(); i++) {
            if (eq(trailerTokens.get(i), "ENGINE")
                    && "=".equals(trailerTokens.get(i + 1).text())
                    && eq(trailerTokens.get(i + 2), "InnoDB")) {
                innoDb = true;
                break;
            }
        }
        if (!innoDb) {
            throw new SQLException("Canonical DDL table must declare ENGINE=InnoDB: " + tableName);
        }
        return parseTableBody(tableName, slice.content());
    }

    private static IndexSpec parseCreateIndex(String stmt, List<Token> head) throws SQLException {
        boolean unique = eq(head.get(1), "UNIQUE");
        int nameIdx = unique ? 3 : 2;
        List<Token> all = scanTokens(stmt, 8);
        if (all.size() <= nameIdx + 2 || !eq(all.get(nameIdx + 1), "ON")) {
            throw new SQLException("Malformed CREATE INDEX statement: " + stmt);
        }
        String indexName = lower(unquote(all.get(nameIdx).text()));
        String tableName = lower(unquote(all.get(nameIdx + 2).text()));
        IndexFields fields =
                parseIndexFields(findParenGroupAfter(stmt, all.get(nameIdx + 2).end()).content());
        return new IndexSpec(indexName, tableName, unique, fields.columns(), fields.prefixes());
    }

    private static void parseConstraintClause(
            String tableName,
            String entry,
            List<Token> tokens,
            List<String> primaryKey,
            List<List<String>> uniqueKeys,
            List<CheckSpec> checks) throws SQLException {
        if (tokens.size() < 3) {
            throw new SQLException("Malformed CONSTRAINT clause in " + tableName + ": " + entry);
        }
        String name = lower(unquote(tokens.get(1).text()));
        String kind = upper(tokens.get(2).text());
        if ("PRIMARY".equals(kind)) {
            requireToken(tokens, 3, "KEY", entry);
            primaryKey.addAll(
                    parseIndexFields(findParenGroupAfter(entry, tokens.get(3).end()).content()).columns());
        } else if ("UNIQUE".equals(kind)) {
            int idx = 3;
            if (idx < tokens.size() && (eq(tokens.get(idx), "KEY") || eq(tokens.get(idx), "INDEX"))) {
                idx++;
                if (idx < tokens.size() && tokens.get(idx).kind() == TokenKind.WORD) {
                    idx++;
                }
            }
            uniqueKeys.add(
                    parseIndexFields(findParenGroupAfter(entry, tokens.get(idx - 1).end()).content()).columns());
        } else if ("CHECK".equals(kind)) {
            checks.add(new CheckSpec(name, parenGroupAfter(entry, tokens.get(2).end())));
        } else {
            throw new SQLException("Unsupported CONSTRAINT kind in " + tableName + ": " + entry);
        }
    }

    private static ColumnSpec parseColumn(String tableName, String entry, List<Token> tokens)
            throws SQLException {
        if (tokens.size() < 2) {
            throw new SQLException("Malformed column definition in " + tableName + ": " + entry);
        }
        String colName = lower(unquote(tokens.get(0).text()));
        String typeName = upper(tokens.get(1).text());
        if (!SUPPORTED_TYPES.contains(typeName)) {
            throw new SQLException(
                    "Unsupported column type in canonical DDL: " + tableName + "." + colName + " " + typeName);
        }
        int idx = 2;
        Integer length = null;
        if (idx < tokens.size() && "(".equals(tokens.get(idx).text())) {
            ParenSlice typeArgs = findParenGroupAt(entry, tokens.get(idx).start());
            String trimmed = typeArgs.content().trim();
            try {
                length = Integer.valueOf(trimmed);
            } catch (NumberFormatException error) {
                throw new SQLException("Invalid type length on " + tableName + "." + colName + ": " + trimmed, error);
            }
            while (idx < tokens.size() && tokens.get(idx).start() <= typeArgs.closeIndex()) {
                idx++;
            }
        }
        boolean unsigned = false;
        boolean autoIncrement = false;
        boolean notNull = false;
        boolean inlinePrimaryKey = false;
        String generatedExpression = null;

        while (idx < tokens.size()) {
            Token tok = tokens.get(idx);
            if (tok.kind() != TokenKind.WORD) {
                idx++;
                continue;
            }
            String word = upper(tok.text());
            if ("UNSIGNED".equals(word)) {
                unsigned = true;
                idx++;
            } else if ("AUTO_INCREMENT".equals(word)) {
                autoIncrement = true;
                idx++;
            } else if ("NOT".equals(word) && idx + 1 < tokens.size() && eq(tokens.get(idx + 1), "NULL")) {
                notNull = true;
                idx += 2;
            } else if ("PRIMARY".equals(word) && idx + 1 < tokens.size() && eq(tokens.get(idx + 1), "KEY")) {
                inlinePrimaryKey = true;
                idx += 2;
            } else if ("GENERATED".equals(word)
                    && idx + 2 < tokens.size()
                    && eq(tokens.get(idx + 1), "ALWAYS")
                    && eq(tokens.get(idx + 2), "AS")) {
                ParenSlice exprSlice = findParenGroupAfter(entry, tokens.get(idx + 2).end());
                generatedExpression = "(" + exprSlice.content() + ")";
                while (idx < tokens.size() && tokens.get(idx).start() <= exprSlice.closeIndex()) {
                    idx++;
                }
            } else if ("COMMENT".equals(word)) {
                idx += 2;
            } else if ("DEFAULT".equals(word)) {
                idx += 2;
            } else {
                idx++;
            }
        }
        return new ColumnSpec(
                colName, typeName, length, unsigned, autoIncrement, notNull, inlinePrimaryKey, generatedExpression);
    }

    private record IndexFields(List<String> columns, List<Integer> prefixes) {}

    private static IndexFields parseIndexFields(String rawList) throws SQLException {
        List<String> cols = new ArrayList<>();
        List<Integer> prefixes = new ArrayList<>();
        for (String item : splitTopLevel(rawList, ',')) {
            String trimmed = item.trim();
            if (trimmed.isEmpty()) {
                continue;
            }
            Integer prefix = null;
            var hintMatcher = INDEX_PREFIX.matcher(trimmed);
            if (hintMatcher.find()) {
                prefix = Integer.valueOf(hintMatcher.group(1));
                trimmed = hintMatcher.replaceAll("").trim();
            }
            var idMatcher = IDENTIFIER_HEAD.matcher(trimmed);
            if (!idMatcher.matches()) {
                throw new SQLException("Malformed index column specification: " + item);
            }
            String col = lower(idMatcher.group(1));
            String rest = idMatcher.group(2).trim();
            if (rest.startsWith("(") && rest.endsWith(")")) {
                prefix = Integer.valueOf(rest.substring(1, rest.length() - 1).trim());
            }
            cols.add(col);
            prefixes.add(prefix);
        }
        return new IndexFields(cols, prefixes);
    }

    private record ParenSlice(String content, int openIndex, int closeIndex) {}

    private static String parenGroupAfter(String text, int startIndex) throws SQLException {
        ParenSlice slice = findParenGroupAfter(text, startIndex);
        return "(" + slice.content() + ")";
    }

    private static ParenSlice findParenGroupAfter(String text, int startIndex) throws SQLException {
        int i = startIndex;
        while (i < text.length() && Character.isWhitespace(text.charAt(i))) {
            i++;
        }
        if (i >= text.length() || text.charAt(i) != '(') {
            throw new SQLException("Expected '(' in DDL near: " + text.substring(Math.min(startIndex, text.length())));
        }
        return findParenGroupAt(text, i);
    }

    private static ParenSlice findParenGroupAt(String text, int openIndex) throws SQLException {
        int depth = 0;
        int i = openIndex;
        while (i < text.length()) {
            char c = text.charAt(i);
            if (c == '\'' || c == '`') {
                i = skipQuoted(text, i, c);
                continue;
            }
            if (c == '-' && i + 1 < text.length() && text.charAt(i + 1) == '-') {
                int nl = text.indexOf('\n', i + 2);
                i = nl < 0 ? text.length() : nl + 1;
                continue;
            }
            if (c == '/' && i + 1 < text.length() && text.charAt(i + 1) == '*') {
                int end = text.indexOf("*/", i + 2);
                if (end < 0) {
                    throw new SQLException("Unterminated block comment in DDL");
                }
                i = end + 2;
                continue;
            }
            if (c == '(') {
                depth++;
            } else if (c == ')') {
                depth--;
                if (depth == 0) {
                    return new ParenSlice(text.substring(openIndex + 1, i), openIndex, i);
                }
            }
            i++;
        }
        throw new SQLException("Unbalanced '(' in DDL");
    }

    private static List<String> splitTopLevel(String text, char delimiter) throws SQLException {
        List<String> parts = new ArrayList<>();
        int depth = 0;
        int start = 0;
        int i = 0;
        while (i < text.length()) {
            char c = text.charAt(i);
            if (c == '\'' || c == '`') {
                i = skipQuoted(text, i, c);
                continue;
            }
            if (c == '-' && i + 1 < text.length() && text.charAt(i + 1) == '-') {
                int nl = text.indexOf('\n', i + 2);
                i = nl < 0 ? text.length() : nl + 1;
                continue;
            }
            if (c == '/' && i + 1 < text.length() && text.charAt(i + 1) == '*') {
                int end = text.indexOf("*/", i + 2);
                if (end < 0) {
                    throw new SQLException("Unterminated block comment in DDL");
                }
                i = end + 2;
                continue;
            }
            if (c == '(') {
                depth++;
            } else if (c == ')') {
                if (depth > 0) {
                    depth--;
                }
            } else if (c == delimiter && depth == 0) {
                String slice = stripLineCommentsOutsideQuotes(text.substring(start, i)).trim();
                if (!slice.isEmpty()) {
                    parts.add(slice);
                }
                start = i + 1;
            }
            i++;
        }
        if (depth != 0) {
            throw new SQLException("Unbalanced parentheses in DDL");
        }
        String tail = stripLineCommentsOutsideQuotes(text.substring(start)).trim();
        if (!tail.isEmpty()) {
            parts.add(tail);
        }
        return parts;
    }

    private static String stripLineCommentsOutsideQuotes(String text) throws SQLException {
        StringBuilder out = new StringBuilder(text.length());
        int i = 0;
        while (i < text.length()) {
            char c = text.charAt(i);
            if (c == '\'' || c == '`') {
                int next = skipQuoted(text, i, c);
                out.append(text, i, next);
                i = next;
            } else if (c == '-' && i + 1 < text.length() && text.charAt(i + 1) == '-') {
                int nl = text.indexOf('\n', i + 2);
                if (nl < 0) {
                    break;
                }
                out.append('\n');
                i = nl + 1;
            } else {
                out.append(c);
                i++;
            }
        }
        return out.toString();
    }

    private static String stripCommentsPreserveHints(String text) throws SQLException {
        StringBuilder out = new StringBuilder(text.length());
        int i = 0;
        while (i < text.length()) {
            char c = text.charAt(i);
            if (c == '\'' || c == '`') {
                int next = skipQuoted(text, i, c);
                out.append(text, i, next);
                i = next;
            } else if (c == '-' && i + 1 < text.length() && text.charAt(i + 1) == '-') {
                int nl = text.indexOf('\n', i + 2);
                if (nl < 0) {
                    break;
                }
                out.append('\n');
                i = nl + 1;
            } else if (c == '/' && i + 1 < text.length() && text.charAt(i + 1) == '*') {
                int end = text.indexOf("*/", i + 2);
                if (end < 0) {
                    throw new SQLException("Unterminated block comment in DDL");
                }
                if (i + 2 < text.length() && text.charAt(i + 2) == '!') {
                    out.append(text, i, end + 2);
                } else {
                    out.append(' ');
                }
                i = end + 2;
            } else {
                out.append(c);
                i++;
            }
        }
        return out.toString();
    }

    private static int skipQuoted(String text, int quotePos, char quote) throws SQLException {
        int i = quotePos + 1;
        while (i < text.length()) {
            char c = text.charAt(i);
            if (c == '\\' && quote == '\'' && i + 1 < text.length()) {
                i += 2;
                continue;
            }
            if (c == quote) {
                if (i + 1 < text.length() && text.charAt(i + 1) == quote) {
                    i += 2;
                    continue;
                }
                return i + 1;
            }
            i++;
        }
        throw new SQLException("Unterminated quoted literal in DDL");
    }

    private enum TokenKind {
        WORD, STRING, SYMBOL
    }

    private record Token(TokenKind kind, String text, int start, int end) {}

    private static List<Token> scanTokens(String text, int maxTokens) throws SQLException {
        List<Token> tokens = new ArrayList<>();
        int i = 0;
        while (i < text.length() && tokens.size() < maxTokens) {
            char c = text.charAt(i);
            if (Character.isWhitespace(c)) {
                i++;
                continue;
            }
            if (c == '-' && i + 1 < text.length() && text.charAt(i + 1) == '-') {
                int nl = text.indexOf('\n', i + 2);
                i = nl < 0 ? text.length() : nl + 1;
                continue;
            }
            if (c == '/' && i + 1 < text.length() && text.charAt(i + 1) == '*') {
                int end = text.indexOf("*/", i + 2);
                if (end < 0) {
                    throw new SQLException("Unterminated block comment in DDL");
                }
                i = end + 2;
                continue;
            }
            if (c == '\'') {
                int next = skipQuoted(text, i, '\'');
                tokens.add(new Token(TokenKind.STRING, text.substring(i, next), i, next));
                i = next;
                continue;
            }
            if (c == '`') {
                int next = skipQuoted(text, i, '`');
                tokens.add(new Token(TokenKind.WORD, text.substring(i, next), i, next));
                i = next;
                continue;
            }
            if (Character.isLetterOrDigit(c) || c == '_') {
                int start = i;
                while (i < text.length()
                        && (Character.isLetterOrDigit(text.charAt(i)) || text.charAt(i) == '_')) {
                    i++;
                }
                tokens.add(new Token(TokenKind.WORD, text.substring(start, i), start, i));
                continue;
            }
            tokens.add(new Token(TokenKind.SYMBOL, String.valueOf(c), i, i + 1));
            i++;
        }
        return tokens;
    }

    private static void requireToken(List<Token> tokens, int index, String expected, String context)
            throws SQLException {
        if (index >= tokens.size() || !eq(tokens.get(index), expected)) {
            throw new SQLException("Expected " + expected + " in DDL clause: " + context);
        }
    }

    private static boolean eq(Token token, String word) {
        return token.kind() == TokenKind.WORD && token.text().equalsIgnoreCase(word);
    }

    private static String unquote(String identifier) {
        if (identifier.length() >= 2 && identifier.startsWith("`") && identifier.endsWith("`")) {
            return identifier.substring(1, identifier.length() - 1).replace("``", "`");
        }
        return identifier;
    }

    private static String lower(String value) {
        return value.toLowerCase(Locale.ROOT);
    }

    private static String upper(String value) {
        return value.toUpperCase(Locale.ROOT);
    }
}
