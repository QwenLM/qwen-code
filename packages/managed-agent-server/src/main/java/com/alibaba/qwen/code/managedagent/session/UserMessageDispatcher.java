package com.alibaba.qwen.code.managedagent.session;

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

    @Scheduled(fixedDelay = 1000)
    public void dispatch() {
        messages.retireClosed();
        for (var session : messages.readySessions()) {
            try {
                messages.startNext(session.get("tenant"), session.get("session"));
            } catch (RuntimeException unavailable) {
                LOG.debug("User message dispatch deferred for Session {}", session.get("session"), unavailable);
            } finally {
                messages.attempted(session.get("tenant"), session.get("session"));
            }
        }
    }
}
