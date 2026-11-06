package com.alibaba.qwen.code.runtimebroker;

import java.util.Map;

@FunctionalInterface
public interface RuntimeMcpTokenIssuer {
    String issue(RuntimeScope scope, String harnessSessionId, Map<String, Object> request);
}
