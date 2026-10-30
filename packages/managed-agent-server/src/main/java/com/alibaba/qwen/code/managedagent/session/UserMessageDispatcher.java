package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.persistence.ManagedUserMessageStore;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
public class UserMessageDispatcher {
    private static final Logger LOG = LoggerFactory.getLogger(UserMessageDispatcher.class);
    private final ManagedUserMessageStore messages;

    public UserMessageDispatcher(ManagedUserMessageStore messages) { this.messages = messages; }

    @Scheduled(scheduler = "managedAgentScheduler", fixedDelay = 1000)
    public void dispatch() {
        messages.retireClosed();
        for (var session : messages.readySessions()) {
            try {
                messages.startNext(session.get("tenant"), session.get("session"));
            } catch (ManagedAgentException unavailable) {
                LOG.debug("User message dispatch deferred for Session {}", session.get("session"), unavailable);
            } catch (RuntimeException failure) {
                LOG.warn("User message dispatch failed for Session {}", session.get("session"), failure);
            } finally {
                messages.attempted(session.get("tenant"), session.get("session"));
            }
        }
    }
}
