package com.alibaba.qwen.code.managedagent.harness;

import com.alibaba.qwen.code.daemon.HostedPermissionRules;
import com.alibaba.qwen.code.daemon.SubmitHarnessTurn;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessRules;

import java.util.List;
import java.util.Map;

public final class SdkHarnessRules implements HarnessRules {
    @Override
    public String payloadDigest(List<Map<String, Object>> input) {
        return SubmitHarnessTurn.computePayloadDigest(input);
    }

    @Override
    public Map<String, List<String>> permissionRules(Map<?, ?> rules) {
        return HostedPermissionRules.copyOf(rules);
    }

    @Override
    public Map<String, List<String>> nonEmptyPermissionRules(Map<String, List<String>> rules) {
        return HostedPermissionRules.nonEmpty(rules);
    }
}
