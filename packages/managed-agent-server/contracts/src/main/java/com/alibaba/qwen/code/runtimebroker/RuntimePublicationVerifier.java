package com.alibaba.qwen.code.runtimebroker;

/** Verifies a saved publication before a v3 dispatch can start. */
@FunctionalInterface
public interface RuntimePublicationVerifier {
    public RuntimePublicationGrant verify(ToolExecutionRecord execution,
            String publicationId, String token);

    public default java.util.Map<String, Object> finished(ToolExecutionRecord execution) {
        return null;
    }

    public default java.util.Map<String, Object> receipt(ToolExecutionRecord execution) {
        return null;
    }
}
