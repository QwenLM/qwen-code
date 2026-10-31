package com.alibaba.qwen.code.managedagent.contracts.artifact;
import java.time.Duration;
import java.util.List;
public interface ToolPublicationRetention {
    public record Candidate(String scope, String publication, String tenant, String session,
            long bytes, String blocker) { }
    public List<Candidate> observe(Duration grace);
}
