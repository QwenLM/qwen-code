package com.alibaba.qwen.code.runtimebroker.persistence;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
public final class InMemoryTestAccess {
    private InMemoryTestAccess() { }
    public static ToolExecutionRecord authorizeDispatch(InMemoryToolExecutionRepository repository, ToolExecutionRecord expected, String owner, long generation, long version) {
        return repository.authorizeDispatch(expected, owner, generation, version);
    }
}
