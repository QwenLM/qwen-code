package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellModelOption;
import com.alibaba.qwen.code.managedagent.settings.ManagedAgentSettings;
import org.apache.commons.lang3.StringUtils;

import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.List;

final class AgentModelCatalog {
    private AgentModelCatalog() {
    }

    static List<WebShellModelOption> options(ManagedAgentSettings properties) {
        var modelIds = new HashSet<String>();
        return properties.getModelCatalog().stream().map(option -> {
            String id = option.getModelId();
            String label = option.getLabel() == null ? id : option.getLabel();
            if (StringUtils.isBlank(id) || id.getBytes(StandardCharsets.UTF_8).length > 512
                    || id.chars().anyMatch(Character::isISOControl) || !modelIds.add(id)
                    || StringUtils.isBlank(label) || label.length() > 512
                    || label.chars().anyMatch(Character::isISOControl)) {
                throw new IllegalArgumentException("Invalid or duplicate Managed model catalog entry");
            }
            return new WebShellModelOption(id, label);
        }).toList();
    }
}
