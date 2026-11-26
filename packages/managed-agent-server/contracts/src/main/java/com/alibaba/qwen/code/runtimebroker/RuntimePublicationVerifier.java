package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.runtimebroker.spi.ExternalShellPublication;

import java.util.Map;

/** Verifies a saved publication before a v3 dispatch can start. */
@FunctionalInterface
public interface RuntimePublicationVerifier {
    public RuntimePublicationGrant verify(ToolExecutionRecord execution,
            String publicationId, String token);

    public default Map<String, Object> finished(ToolExecutionRecord execution) {
        return null;
    }

    public default Map<String, Object> receipt(ToolExecutionRecord execution) {
        return null;
    }

    /**
     * The external foreground-Shell capture lane, if this Runtime family has
     * one. Null keeps every other placement on its installed-grant path.
     */
    public default ExternalShellPublication externalShell() {
        return null;
    }
}
