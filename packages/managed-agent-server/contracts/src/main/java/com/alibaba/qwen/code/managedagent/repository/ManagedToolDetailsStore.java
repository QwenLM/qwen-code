package com.alibaba.qwen.code.managedagent.repository;

import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellToolDetails;

public interface ManagedToolDetailsStore {
    public WebShellToolDetails read(String tenant, String workspace,
            String session, String itemId);
}
