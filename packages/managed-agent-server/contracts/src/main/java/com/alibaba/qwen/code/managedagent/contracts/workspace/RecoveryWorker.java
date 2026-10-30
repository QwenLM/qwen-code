package com.alibaba.qwen.code.managedagent.contracts.workspace;

import com.fasterxml.jackson.databind.JsonNode;

import java.io.IOException;
import java.nio.file.Path;
import java.util.function.BiFunction;
public interface RecoveryWorker {
    interface Session {
        void workerFailed();
        JsonNode inspect();
    }
    void execute(JsonNode request, Session session, BiFunction<String, JsonNode, JsonNode> calls) throws Exception;
    void validateStateDirectory(Path directory) throws IOException;
}
