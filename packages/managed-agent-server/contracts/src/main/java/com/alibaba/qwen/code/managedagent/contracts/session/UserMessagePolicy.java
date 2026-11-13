package com.alibaba.qwen.code.managedagent.contracts.session;

import com.alibaba.qwen.code.managedagent.model.ApiModels.InputBlock;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;

import java.util.List;
import java.util.Map;

public interface UserMessagePolicy {
    public boolean supportsUserMessageQueue();
    public SessionRecord authorizeUserMessageActor(String tenantId, String actorId, String sessionId);
    public SessionRecord authorizeUserMessages(String tenantId, String actorId, String sessionId);
    public List<Map<String, Object>> userMessageInput(List<InputBlock> blocks);
}
