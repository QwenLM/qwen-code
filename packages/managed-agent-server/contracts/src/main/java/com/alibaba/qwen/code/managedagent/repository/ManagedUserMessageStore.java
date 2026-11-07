package com.alibaba.qwen.code.managedagent.repository;

import com.alibaba.qwen.code.managedagent.model.ApiModels;
import com.alibaba.qwen.code.managedagent.model.ApiModels.InputBlock;
import com.alibaba.qwen.code.managedagent.model.SessionPrincipal;

import java.util.List;
import java.util.Map;

public interface ManagedUserMessageStore {
    public record Message(String id, long sequence, long revision, String state,
            List<Map<String, Object>> input, String turnId) { }

    public record Snapshot(boolean paused, List<Message> messages) { }

    public record Command(String action, String messageId, Long expectedRevision, List<InputBlock> input) { }

    public default Snapshot queryMessages(String tenant, String actor,
            String session) {
        return queryMessages(actor == null ? null
                : SessionPrincipal.ofUser(tenant, actor), session);
    }

    public Snapshot queryMessages(SessionPrincipal principal, String session);

    public default Snapshot command(String tenant, String actor, String session,
            String key, Command command) {
        return command(actor == null ? null
                : SessionPrincipal.ofUser(tenant, actor), session, key, command);
    }

    public Snapshot command(SessionPrincipal principal, String session,
            String key, Command command);

    public List<Message> claim(String tenant, String session, String promptId, boolean initialOnly);

    public List<Map<String, String>> readySessions();

    public void attempted(String tenant, String session);

    @FunctionalInterface
    public interface QueuedTurnSubmitter {
        public com.alibaba.qwen.code.managedagent.model.ApiModels.CommandAdmission submit(SessionPrincipal principal,
                String idempotencyKey, String sessionId,
                List<com.alibaba.qwen.code.managedagent.model.ApiModels.InputBlock> input);
    }

    public void startNext(String tenant, String session, QueuedTurnSubmitter submitter);

    public void retireClosed();
}
