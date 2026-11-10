package com.alibaba.qwen.code.managedagent.contracts.memory;

import com.alibaba.qwen.code.managedagent.contracts.memory.MemoryModels.Admission;
import com.alibaba.qwen.code.managedagent.contracts.memory.MemoryModels.Query;
import com.alibaba.qwen.code.managedagent.contracts.memory.MemoryModels.Result;
import com.alibaba.qwen.code.managedagent.contracts.memory.MemoryModels.Store;

import java.util.List;

public interface MemoryRepository {
    void requireEnabled();
    Store create(String tenantId, String actorId);
    List<Store> list(String tenantId, String actorId);
    Admission admit(String tenantId, String sessionId, String writerToken, Query query);
    Result complete(Admission admission, Result result);
}
