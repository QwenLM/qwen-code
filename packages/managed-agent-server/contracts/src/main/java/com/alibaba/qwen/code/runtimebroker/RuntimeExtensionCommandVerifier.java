package com.alibaba.qwen.code.runtimebroker;

import java.util.Map;

/** Checks the committed ordinary-tool permission before an extension command dispatch. */
@FunctionalInterface
public interface RuntimeExtensionCommandVerifier {
    public void verify(RuntimeBindingRecord runtime, RuntimeSession session, Map<String, Object> operation);
}
