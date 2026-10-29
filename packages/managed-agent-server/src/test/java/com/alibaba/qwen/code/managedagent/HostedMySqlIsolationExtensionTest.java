package com.alibaba.qwen.code.managedagent;

import org.assertj.core.api.ThrowableAssert.ThrowingCallable;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtensionContext;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.NullSource;
import org.junit.jupiter.params.provider.ValueSource;

import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.catchThrowable;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.mockStatic;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoMoreInteractions;
import static org.mockito.Mockito.when;

class HostedMySqlIsolationExtensionTest {
    // Valid shape, closed port: a guard that fails to return reaches
    // DriverManager and throws instead of silently truncating a live catalog.
    private static final String UNREACHABLE_URL =
            "jdbc:mysql://127.0.0.1:1/unreachable?connectTimeout=500&socketTimeout=500";
    private static final String REQUIRED =
            "Hosted isolation requires a disposable mysql.url and mysql.user";

    @Test
    void remainsInactiveWhenOnlyServiceDiscoveryIsEnabled() throws Throwable {
        var context = mock(ExtensionContext.class);
        withMysql(UNREACHABLE_URL, "unreachable", () ->
                assertThatCode(() -> new HostedMySqlIsolationExtension().beforeAll(context))
                        .doesNotThrowAnyException());
    }

    @Test
    void nestedClassSetupDoesNotRequireOrClearTheDatabase() throws Throwable {
        var context = mock(ExtensionContext.class);
        var parent = mock(ExtensionContext.class);
        when(context.getConfigurationParameter(HostedMySqlIsolationExtension.ENABLED))
                .thenReturn(Optional.of("true"));
        when(context.getParent()).thenReturn(Optional.of(parent));
        when(parent.getTestClass()).thenReturn(Optional.of(getClass()));
        withMysql(UNREACHABLE_URL, "unreachable", () ->
                assertThatCode(() -> new HostedMySqlIsolationExtension().beforeAll(context))
                        .doesNotThrowAnyException());
    }

    @ParameterizedTest
    @NullSource
    @ValueSource(strings = {
            "jdbc:h2:mem:hosted-isolation",
            "jdbc:mysql:replication://127.0.0.1:1/unreachable"})
    void refusesMissingOrNonMySqlUrlWhenEnabled(String url) throws Throwable {
        var context = enabledContext();
        withMysql(url, "root", () ->
                assertThatThrownBy(() -> new HostedMySqlIsolationExtension().beforeAll(context))
                        .isInstanceOf(IllegalArgumentException.class)
                        .hasMessage(REQUIRED));
    }

    @Test
    void refusesMissingUserWhenEnabled() throws Throwable {
        var context = enabledContext();
        withMysql(UNREACHABLE_URL, null, () ->
                assertThatThrownBy(() -> new HostedMySqlIsolationExtension().beforeAll(context))
                        .isInstanceOf(IllegalArgumentException.class)
                        .hasMessage(REQUIRED));
    }

    @ParameterizedTest(name = "truncateFails={0}, restoreFails={1}")
    @CsvSource({"true, true", "true, false", "false, true", "false, false"})
    void preservesCleanupFailureAndClosesResources(boolean truncateFails, boolean restoreFails)
            throws Throwable {
        var connection = mock(Connection.class);
        var metadata = mock(DatabaseMetaData.class);
        var tables = mock(Statement.class);
        var cleanup = mock(Statement.class);
        var rows = mock(ResultSet.class);
        when(connection.getMetaData()).thenReturn(metadata);
        when(metadata.getDatabaseProductName()).thenReturn("MySQL");
        when(connection.getCatalog()).thenReturn("hosted_isolation_test");
        when(connection.createStatement()).thenReturn(tables, cleanup);
        when(tables.executeQuery(anyString())).thenReturn(rows);
        when(rows.next()).thenReturn(true, true, false);
        when(rows.getString(1)).thenReturn("ma_sessions", "unrelated_table");
        var truncateFailure = new SQLException("truncate failed", "42000", 1234);
        var restoreFailure = new SQLException("restore failed", "08000", 5678);
        if (truncateFails) {
            when(cleanup.execute("TRUNCATE TABLE `ma_sessions`")).thenThrow(truncateFailure);
        }
        if (restoreFails) {
            when(cleanup.execute("SET FOREIGN_KEY_CHECKS = 1")).thenThrow(restoreFailure);
        }

        withMysql(UNREACHABLE_URL, "unreachable", () -> {
            try (var drivers = mockStatic(DriverManager.class)) {
                drivers.when(() -> DriverManager.getConnection(UNREACHABLE_URL,
                        "unreachable", System.getProperty("mysql.password", "")))
                        .thenReturn(connection);

                Throwable failure = catchThrowable(() ->
                        new HostedMySqlIsolationExtension().beforeAll(enabledContext()));

                if (truncateFails) {
                    assertThat(failure).isSameAs(truncateFailure);
                    assertThat(failure.getSuppressed()).containsExactly(
                            restoreFails ? new Throwable[] {restoreFailure} : new Throwable[0]);
                } else if (restoreFails) {
                    assertThat(failure).isSameAs(restoreFailure);
                    assertThat(failure.getSuppressed()).isEmpty();
                } else {
                    assertThat(failure).isNull();
                }
                drivers.verify(() -> DriverManager.getConnection(UNREACHABLE_URL,
                        "unreachable", System.getProperty("mysql.password", "")));
                drivers.verifyNoMoreInteractions();
            }
        });

        var order = inOrder(rows, tables, cleanup, connection);
        order.verify(rows).close();
        order.verify(tables).close();
        order.verify(cleanup).execute("SET FOREIGN_KEY_CHECKS = 0");
        order.verify(cleanup).execute("TRUNCATE TABLE `ma_sessions`");
        order.verify(cleanup).execute("SET FOREIGN_KEY_CHECKS = 1");
        order.verify(cleanup).close();
        order.verify(connection).close();
        verify(connection, times(2)).createStatement();
        verifyNoMoreInteractions(cleanup);
    }

    private static ExtensionContext enabledContext() {
        var context = mock(ExtensionContext.class);
        when(context.getConfigurationParameter(HostedMySqlIsolationExtension.ENABLED))
                .thenReturn(Optional.of("true"));
        return context;
    }

    private static void withMysql(String url, String user, ThrowingCallable body) throws Throwable {
        String originalUrl = System.getProperty("mysql.url");
        String originalUser = System.getProperty("mysql.user");
        try {
            setOrClear("mysql.url", url);
            setOrClear("mysql.user", user);
            body.call();
        } finally {
            setOrClear("mysql.url", originalUrl);
            setOrClear("mysql.user", originalUser);
        }
    }

    private static void setOrClear(String key, String value) {
        if (value == null) {
            System.clearProperty(key);
        } else {
            System.setProperty(key, value);
        }
    }
}
