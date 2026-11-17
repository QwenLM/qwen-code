package com.alibaba.qwen.code.managedagent.contracts.memory;

import com.alibaba.qwen.code.managedagent.contracts.memory.MemoryModels.Query;
import com.alibaba.qwen.code.managedagent.contracts.memory.MemoryModels.Result;

public interface MemoryProvider {
    Result execute(String namespace, Query query);
}
