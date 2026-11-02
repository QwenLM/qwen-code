package com.alibaba.qwen.code.managedagent.persistence;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static com.alibaba.qwen.code.managedagent.persistence.StoreLockTrace.Phase.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class StoreLockTraceTest {
    private static StoreLockTrace.Event event(StoreLockTrace.Phase phase, long connection, long tx, String table, String session) {
        return new StoreLockTrace.Event(phase, connection, tx, false,
                "select * from " + table + " where tenant_id = ? and session_id = ? for update",
                Map.of(1, "tenant", 2, session));
    }

    @ParameterizedTest
    @ValueSource(strings = {"missing", "reverse", "connection", "commit", "rollback", "session", "attempt", "failed"})
    void refusesFalseLockProofs(String damage) {
        var root = event(SUCCEEDED, 1, 1, "ma_session", "session");
        var turn = event(SUCCEEDED, 1, 1, "ma_turn", "session");
        var events = new ArrayList<StoreLockTrace.Event>();
        switch (damage) {
            case "missing" -> events.add(event(BEGIN, 1, 1, "", "session"));
            case "reverse" -> events.add(turn);
            case "connection" -> events.add(event(SUCCEEDED, 2, 1, "ma_session", "session"));
            case "commit", "rollback" -> {
                events.add(root);
                events.add(event(damage.equals("commit") ? COMMIT : ROLLBACK, 1, 1, "", "session"));
            }
            case "session" -> events.add(event(SUCCEEDED, 1, 1, "ma_session", "another-session"));
            case "attempt" -> events.add(event(ATTEMPT, 1, 1, "ma_session", "session"));
            case "failed" -> events.add(event(FAILED, 1, 1, "ma_session", "session"));
            default -> throw new IllegalArgumentException(damage);
        }
        events.add(turn);
        assertThatThrownBy(() -> StoreLockTrace.assertOrder(events, "tenant", "session", false)).isInstanceOf(AssertionError.class);
        StoreLockTrace.assertOrder(List.of(root, turn), "tenant", "session", false);
    }

    @ParameterizedTest
    @ValueSource(strings = {"missing", "reverse", "connection", "commit", "session"})
    void recordsAndRejectsActualJdbcOrderViolations(String damage) throws Exception {
        var trace = new StoreLockTrace(new DriverManagerDataSource("jdbc:h2:mem:bad-order-"
                + java.util.UUID.randomUUID() + ";DB_CLOSE_DELAY=-1", "sa", ""));
        try (var setup = trace.getConnection(); var statement = setup.createStatement()) {
            statement.execute("CREATE TABLE ma_session (tenant_id VARCHAR, session_id VARCHAR)");
            statement.execute("CREATE TABLE ma_turn (tenant_id VARCHAR, session_id VARCHAR)");
            statement.execute("INSERT INTO ma_session VALUES ('tenant', 'session'), ('tenant', 'another-session')");
            statement.execute("INSERT INTO ma_turn VALUES ('tenant', 'session')");
        }
        trace.clear();
        try (var first = trace.getConnection(); var second = trace.getConnection()) {
            first.setAutoCommit(false);
            second.setAutoCommit(false);
            if (damage.equals("reverse")) {
                read(first, "ma_turn", "session");
            }
            if (!damage.equals("missing")) {
                read(damage.equals("connection") ? second : first, "ma_session",
                        damage.equals("session") ? "another-session" : "session");
            }
            if (damage.equals("commit")) {
                first.commit();
            }
            read(first, "ma_turn", "session");
        }
        assertThatThrownBy(() -> trace.assertSessionBeforeTurn("tenant", "session")).isInstanceOf(AssertionError.class);
    }

    private static void read(java.sql.Connection connection, String table, String session) throws Exception {
        try (var statement = connection.prepareStatement("select * from " + table
                + " where tenant_id = ? and session_id = ? for update")) {
            statement.setString(1, "tenant");
            statement.setString(2, session);
            try (var rows = statement.executeQuery()) {
                assertThat(rows.next()).isTrue();
            }
        }
    }

    @Test
    void batchBindsAreCopiedAtAddAndRecordedOnlyAtExecution() throws Exception {
        var trace = new StoreLockTrace(new DriverManagerDataSource("jdbc:h2:mem:trace-batch", "sa", ""));
        try (var connection = trace.getConnection(); var create = connection.createStatement()) {
            create.execute("CREATE TABLE probe (id INTEGER PRIMARY KEY)");
            trace.clear();
            try (var statement = connection.prepareStatement("INSERT INTO probe VALUES (?)")) {
                statement.setInt(1, 1);
                statement.addBatch();
                statement.setInt(1, 2);
                statement.addBatch();
                assertThat(trace.events()).isEmpty();
                statement.executeBatch();
                assertThat(trace.events().stream().filter(event -> event.phase() == SUCCEEDED)
                        .map(event -> event.arguments().get(1))).containsExactly("1", "2");
            }
        }
    }

    @Test
    void preparationIsNotExecutionAndFailedExecutionIsNotSuccess() throws Exception {
        var trace = new StoreLockTrace(new DriverManagerDataSource("jdbc:h2:mem:trace", "sa", ""));
        try (var connection = trace.getConnection()) {
            connection.createStatement().execute("CREATE TABLE probe (id INTEGER PRIMARY KEY)");
            trace.clear();
            try (var statement = connection.prepareStatement("INSERT INTO probe VALUES (?)")) {
                statement.setInt(1, 1);
                assertThat(trace.events()).isEmpty();
                statement.executeUpdate();
                assertThatThrownBy(statement::executeUpdate).isInstanceOf(java.sql.SQLException.class);
            }
        }
        assertThat(trace.events().stream().map(StoreLockTrace.Event::phase)).containsExactly(ATTEMPT, SUCCEEDED, ATTEMPT, FAILED, CLOSE);
    }
}
