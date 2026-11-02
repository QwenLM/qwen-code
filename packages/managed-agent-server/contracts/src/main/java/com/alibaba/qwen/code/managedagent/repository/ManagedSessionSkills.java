package com.alibaba.qwen.code.managedagent.repository;

import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;

import java.util.List;
import java.util.Map;

public interface ManagedSessionSkills {
    public List<Map<String, Object>> fromLaunchReference(String tenant, String session,
            com.fasterxml.jackson.databind.JsonNode ref);

    public List<Map<String, Object>> effective(SessionRecord session);

    public List<Map<String, Object>> snapshot(String tenant, String session);

    public Map<String, Object> initialSelection(String tenant, String session);

    public void saveInitialSelection(String tenant, String session,
            List<com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedExtensionPackages.Pin> pins);

    public void save(String tenant, String session, List<Map<String, Object>> skills);
}
