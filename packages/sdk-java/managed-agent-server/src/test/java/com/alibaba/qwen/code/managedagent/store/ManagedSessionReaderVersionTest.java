package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.http.HttpStatus;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class ManagedSessionReaderVersionTest {
    @AfterEach
    void resetRequest() {
        RequestContextHolder.resetRequestAttributes();
    }

    @ParameterizedTest
    @ValueSource(strings = {
            "/internal/managed-session-store/session/restore",
            "/%69%6Eternal/managed-session-store/session/restore",
            "/internal/managed-session-store;x=y/session/restore",
            "/internal/managed-tool-publications/session/replay",
            "/%69%6Eternal/managed-tool-publications/session/replay",
            "/internal/managed-tool-publications;x=y/session/replay"
    })
    void normalizedInternalRoutesRequireTheRemoteReaderCeiling(String path) {
        var request = new MockHttpServletRequest();
        request.setContextPath("/app");
        request.setRequestURI("/app" + path);
        RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(request));

        assertDoesNotThrow(() -> ManagedSessionReaderVersion.requireReadable(1));
        assertUnsupported();
        request.addHeader(ManagedSessionReaderVersion.HEADER, "1");
        assertUnsupported();
        request.removeHeader(ManagedSessionReaderVersion.HEADER);
        request.addHeader(ManagedSessionReaderVersion.HEADER, "2");
        assertDoesNotThrow(() -> ManagedSessionReaderVersion.requireReadable(2));
    }

    @Test
    void publicAndInProcessReadersRetainBothFormats() {
        assertDoesNotThrow(() -> ManagedSessionReaderVersion.requireReadable(2));
        var request = new MockHttpServletRequest();
        request.setRequestURI("/v1/agents/agent/sessions/session");
        RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(request));
        assertDoesNotThrow(() -> ManagedSessionReaderVersion.requireReadable(2));
    }

    private static void assertUnsupported() {
        var failure = assertThrows(ApiException.class,
                () -> ManagedSessionReaderVersion.requireReadable(2));
        assertEquals(HttpStatus.CONFLICT, failure.getStatus());
        assertEquals("managed_session_reader_version_unsupported", failure.getCode());
    }
}
