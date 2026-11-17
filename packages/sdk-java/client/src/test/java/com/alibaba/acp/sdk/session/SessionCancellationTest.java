package com.alibaba.acp.sdk.session;

import com.alibaba.acp.sdk.protocol.client.notification.CancelNotification;
import com.alibaba.acp.sdk.protocol.client.notification.CancelNotification.CancelNotificationParams;
import com.alibaba.acp.sdk.protocol.client.request.LoadSessionRequest.LoadSessionRequestParams;
import com.alibaba.acp.sdk.protocol.jsonrpc.Request;
import com.alibaba.acp.sdk.transport.Transport;
import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONObject;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.function.Function;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;

class SessionCancellationTest {
    @Test
    void scopesCancellationNotificationsToTheirSessions() throws IOException {
        CaptureTransport transport = new CaptureTransport();
        new Session(transport, new LoadSessionRequestParams().setSessionId("session-a")).cancel();
        new Session(transport, new LoadSessionRequestParams().setSessionId("session-b")).cancel();

        assertEquals(2, transport.messages.size());
        for (int i = 0; i < transport.messages.size(); i++) {
            JSONObject notification = JSON.parseObject(transport.messages.get(i));
            assertEquals("2.0", notification.getString("jsonrpc"));
            assertEquals("session/cancel", notification.getString("method"));
            JSONObject params = notification.getJSONObject("params");
            assertNotNull(params);
            assertEquals(i == 0 ? "session-a" : "session-b", params.getString("sessionId"));
            assertFalse(notification.containsKey("id"));
        }
    }

    @Test
    void notificationConstructorsDoNotGenerateRequestIds() {
        CancelNotification[] notifications = {
                new CancelNotification(),
                new CancelNotification("session/cancel", new CancelNotificationParams("session-a"))
        };
        for (CancelNotification notification : notifications) {
            assertFalse(JSON.parseObject(notification.toString()).containsKey("id"));
        }
    }

    @Test
    void requestsKeepTheirCorrelationIds() {
        Request<?> request = new Request<>("session/prompt", Collections.singletonMap("sessionId", "session-a"));
        JSONObject serialized = JSON.parseObject(request.toString());

        assertNotNull(serialized.getString("id"));
        assertEquals(request.getId(), serialized.getString("id"));
    }

    @Test
    void propagatesCancellationWriteFailures() {
        CaptureTransport transport = new CaptureTransport();
        transport.failure = new IOException("fixture write failure");
        Session session = new Session(transport, new LoadSessionRequestParams().setSessionId("session-a"));

        assertSame(transport.failure, assertThrows(IOException.class, session::cancel));
    }

    private static final class CaptureTransport implements Transport {
        private final List<String> messages = new ArrayList<>();
        private IOException failure;

        @Override
        public boolean isReading() {
            return false;
        }

        @Override
        public void start() {}

        @Override
        public void close() {}

        @Override
        public boolean isAvailable() {
            return true;
        }

        @Override
        public String inputWaitForOneLine(String message) {
            throw new AssertionError("Cancellation must not wait for a response");
        }

        @Override
        public void inputWaitForMultiLine(String message, Function<String, Boolean> callback) {
            throw new AssertionError("Cancellation must not wait for a response");
        }

        @Override
        public void inputNoWaitResponse(String message) throws IOException {
            if (failure != null) {
                throw failure;
            }
            messages.add(message);
        }
    }
}
