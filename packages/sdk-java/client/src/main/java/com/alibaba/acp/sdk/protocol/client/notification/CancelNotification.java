package com.alibaba.acp.sdk.protocol.client.notification;

import com.alibaba.acp.sdk.protocol.client.notification.CancelNotification.CancelNotificationParams;

public class CancelNotification extends ClientNotification<CancelNotificationParams> {
    public CancelNotification() {
        super();
        this.method = "session/cancel";
    }

    public CancelNotification(String method, CancelNotificationParams params) {
        super(method, params);
    }

    public static class CancelNotificationParams {
        private String sessionId;

        public CancelNotificationParams() {
        }

        public CancelNotificationParams(String sessionId) {
            this.sessionId = sessionId;
        }

        public String getSessionId() {
            return sessionId;
        }

        public void setSessionId(String sessionId) {
            this.sessionId = sessionId;
        }
    }
}
