package com.alibaba.acp.sdk.protocol.agent.notification;

import com.alibaba.acp.sdk.protocol.agent.notification.SessionNotification.SessionNotificationParams;
import com.alibaba.acp.sdk.protocol.domain.session.update.SessionUpdate;
import com.alibaba.fastjson2.annotation.JSONType;

@JSONType(typeName = "session/update")
public class SessionNotification extends AgentNotification<SessionNotificationParams> {
    public SessionNotification() {
        super();
        this.method = "session/update";
    }

    public static class SessionNotificationParams {
        private String sessionId;
        private SessionUpdate update;

        public SessionNotificationParams() {
        }

        public SessionNotificationParams(String sessionId, SessionUpdate update) {
            this.sessionId = sessionId;
            this.update = update;
        }

        public String getSessionId() {
            return sessionId;
        }

        public void setSessionId(String sessionId) {
            this.sessionId = sessionId;
        }

        public SessionUpdate getUpdate() {
            return update;
        }

        public void setUpdate(SessionUpdate update) {
            this.update = update;
        }
    }
}
