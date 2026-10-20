package com.alibaba.qwen.code.managedagent;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtensionContext;

import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThatCode;
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
}
