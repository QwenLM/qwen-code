package com.alibaba.qwen.code.managedagent.harness.contracts;

import java.util.List;
import java.util.Map;

public interface HarnessRules {
    public String payloadDigest(List<Map<String, Object>> input);
    public Map<String, List<String>> permissionRules(Map<?, ?> rules);
    public Map<String, List<String>> nonEmptyPermissionRules(Map<String, List<String>> rules);
}
