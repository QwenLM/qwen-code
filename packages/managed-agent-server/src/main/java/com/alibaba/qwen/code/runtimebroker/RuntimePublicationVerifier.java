package com.alibaba.qwen.code.runtimebroker;

/** Verifies a saved publication before a v3 dispatch can start. */
@FunctionalInterface
public interface RuntimePublicationVerifier {
    RuntimePublicationGrant verify(ToolExecutionRecord execution,
            String publicationId, String token);

    default java.util.Map<String, Object> finished(ToolExecutionRecord execution) {
        return null;
    }

    default java.util.Map<String, Object> receipt(ToolExecutionRecord execution) {
        return null;
    }
}
