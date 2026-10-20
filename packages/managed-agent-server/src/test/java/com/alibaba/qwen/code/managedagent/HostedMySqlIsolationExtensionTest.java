package com.alibaba.qwen.code.managedagent;

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
    @Test
    void remainsInactiveWhenOnlyServiceDiscoveryIsEnabled() {
        var context = mock(ExtensionContext.class);
        assertThatCode(() -> new HostedMySqlIsolationExtension().beforeAll(context))
                .doesNotThrowAnyException();
    }

    @Test
    void nestedClassSetupDoesNotRequireOrClearTheDatabase() {
        var context = mock(ExtensionContext.class);
        var parent = mock(ExtensionContext.class);
        when(context.getConfigurationParameter(HostedMySqlIsolationExtension.ENABLED))
                .thenReturn(Optional.of("true"));
        when(context.getParent()).thenReturn(Optional.of(parent));
        when(parent.getTestClass()).thenReturn(Optional.of(getClass()));
        assertThatCode(() -> new HostedMySqlIsolationExtension().beforeAll(context))
                .doesNotThrowAnyException();
    }

    @ParameterizedTest
    @NullSource
    @ValueSource(strings = "jdbc:h2:mem:hosted-isolation")
    void refusesMissingOrNonMySqlUrlWhenEnabled(String url) {
        var context = mock(ExtensionContext.class);
        when(context.getConfigurationParameter(HostedMySqlIsolationExtension.ENABLED))
                .thenReturn(Optional.of("true"));
        String originalUrl = System.getProperty("mysql.url");
        try {
            if (url == null) {
                System.clearProperty("mysql.url");
            } else {
                System.setProperty("mysql.url", url);
            }
            assertThatThrownBy(() -> new HostedMySqlIsolationExtension().beforeAll(context))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessage("Hosted isolation requires a disposable mysql.url");
        } finally {
            if (originalUrl == null) {
                System.clearProperty("mysql.url");
            } else {
                System.setProperty("mysql.url", originalUrl);
            }
        }
    }
}
