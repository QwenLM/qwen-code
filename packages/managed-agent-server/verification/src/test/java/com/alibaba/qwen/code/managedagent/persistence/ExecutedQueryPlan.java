package com.alibaba.qwen.code.managedagent.persistence;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.JdbcTemplate;

import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

final class ExecutedQueryPlan {
    private static final Pattern MYSQL_ROWS = Pattern.compile(
            "actual time=[^)]*?rows=([0-9.]+) loops=([0-9.]+)");

    private ExecutedQueryPlan() {}

    static Plan explain(JdbcTemplate jdbc, String sql, Object... arguments) {
        boolean mariaDb;
        try (var connection = java.util.Objects.requireNonNull(jdbc.getDataSource()).getConnection()) {
            mariaDb = connection.getMetaData().getDatabaseProductVersion().contains("MariaDB");
        } catch (SQLException error) {
            throw new IllegalStateException("Cannot identify execution-plan dialect", error);
        }
        String plan = jdbc.queryForObject(
                (mariaDb ? "ANALYZE FORMAT=JSON " : "EXPLAIN ANALYZE ") + sql,
                String.class, arguments);
        return mariaDb ? mariaDb(plan) : mysql(plan);
    }

    static Plan mysql(String text) {
        var counts = new ArrayList<Double>();
        var rows = MYSQL_ROWS.matcher(text);
        while (rows.find()) {
            counts.add(Double.parseDouble(rows.group(1)) * Double.parseDouble(rows.group(2)));
        }
        return new Plan(text, counts, List.of(), List.of(), text.contains("Table scan"), false);
    }

    static Plan mariaDb(String text) {
        var counts = new ArrayList<Double>();
        var indexes = new ArrayList<String>();
        var preExecutionPages = new ArrayList<Long>();
        try {
            JsonNode root = new ObjectMapper().readTree(text);
            boolean tableScan = collect(root, counts, indexes, preExecutionPages);
            return new Plan(text, counts, indexes, preExecutionPages, tableScan, true);
        } catch (java.io.IOException error) {
            throw new IllegalArgumentException("Invalid MariaDB execution plan", error);
        }
    }

    private static boolean collect(JsonNode node, List<Double> counts, List<String> indexes,
                                   List<Long> preExecutionPages) {
        boolean tableScan = false;
        if (node.has("table_name")) {
            tableScan = "ALL".equals(node.path("access_type").asText());
            if (node.path("key").isTextual()) {
                indexes.add(node.path("key").asText());
            }
            JsonNode rows = node.path("r_rows");
            JsonNode loops = node.path("r_loops");
            if (rows.isNumber() && loops.isNumber()) {
                counts.add(rows.asDouble() * loops.asDouble());
            } else if (loops.isNumber() && loops.asDouble() == 0 && rows.isNull()) {
                counts.add(0d);
                JsonNode pages = node.path("r_engine_stats").path("pages_accessed");
                if ("const".equals(node.path("access_type").asText())
                        && "PRIMARY".equals(node.path("key").asText())
                        && pages.isIntegralNumber() && pages.canConvertToLong() && pages.asLong() > 0) {
                    preExecutionPages.add(pages.asLong());
                }
            } else {
                throw new IllegalArgumentException("Missing actual row/loop statistics: " + node);
            }
        }
        for (JsonNode child : node) {
            tableScan |= collect(child, counts, indexes, preExecutionPages);
        }
        return tableScan;
    }

    record Plan(String text, List<Double> rowCounts, List<String> indexes,
                List<Long> preExecutionPages, boolean tableScan, boolean mariaDb) {
        long scannedRows() {
            return rowCounts.stream().mapToLong(Math::round).sum();
        }

        long preExecutionPageReads() {
            return preExecutionPages.stream().mapToLong(Long::longValue).sum();
        }

        boolean usesIndex(String index) {
            return mariaDb ? indexes.contains(index) : text.contains(index);
        }
    }
}
