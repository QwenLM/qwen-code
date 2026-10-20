package com.alibaba.qwen.code.managedagent;

import org.assertj.core.api.ThrowableAssert.ThrowingCallable;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtensionContext;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.NullSource;
import org.junit.jupiter.params.provider.ValueSource;

import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
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
