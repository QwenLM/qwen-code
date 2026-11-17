package com.alibaba.acp.sdk;

import com.alibaba.acp.sdk.transport.Transport;
import com.alibaba.acp.sdk.utils.AgentInitializeException;
import java.io.IOException;
import java.util.function.Function;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class AcpClientInitializationCleanupTest {
    @Test
    void serverRejectionClosesTheStartedTransport() {
        TrackingTransport transport = new TrackingTransport();

        AgentInitializeException failure = assertThrows(AgentInitializeException.class, () -> new AcpClient(transport));

        assertTrue(failure.getMessage().contains("fixture initialization rejected"));
        assertEquals(1, transport.closes);
    }

    @Test
    void preservesTransportFailureWhileClosing() {
        TrackingTransport transport = new TrackingTransport();
        transport.readFailure = new IOException("fixture read failure");

        AgentInitializeException failure = assertThrows(AgentInitializeException.class, () -> new AcpClient(transport));

        assertSame(transport.readFailure, failure.getCause());
        assertEquals(1, transport.closes);
    }

    @Test
    void preservesStartFailureWhileReleasingPartialStartup() {
        TrackingTransport transport = new TrackingTransport();
        transport.startFailure = new IOException("fixture start failure");

        AgentInitializeException failure = assertThrows(AgentInitializeException.class, () -> new AcpClient(transport));

        assertSame(transport.startFailure, failure.getCause());
        assertTrue(failure.getMessage().contains("transport start error"));
        assertEquals(1, transport.closes);
    }

    @Test
    void malformedResponsesAlsoCloseTheTransport() {
        TrackingTransport transport = new TrackingTransport();
        transport.response = "not JSON";

        assertThrows(RuntimeException.class, () -> new AcpClient(transport));

        assertEquals(1, transport.closes);
    }

    @Test
    void successfulInitializationLeavesOwnershipWithTheClient() throws Exception {
        TrackingTransport transport = new TrackingTransport();
        transport.response = "{\"jsonrpc\":\"2.0\",\"result\":{\"protocolVersion\":1}}";

        AcpClient client = new AcpClient(transport);

        assertEquals(0, transport.closes);
        client.close();
        assertEquals(1, transport.closes);
    }

    @Test
    void cleanupFailureDoesNotReplaceTheInitializationError() {
        TrackingTransport transport = new TrackingTransport();
        transport.closeFailure = new IOException("fixture close failure");

        AgentInitializeException failure = assertThrows(AgentInitializeException.class, () -> new AcpClient(transport));

        assertTrue(failure.getMessage().contains("fixture initialization rejected"));
        assertEquals(1, failure.getSuppressed().length);
        assertSame(transport.closeFailure, failure.getSuppressed()[0]);
    }

    @Test
    void invalidParametersDoNotStartTheTransport() {
        TrackingTransport transport = new TrackingTransport();

        assertThrows(NullPointerException.class, () -> new AcpClient(transport, null));

        assertEquals(0, transport.starts);
        assertEquals(0, transport.closes);
    }

    private static final class TrackingTransport implements Transport {
        private int starts;
        private int closes;
        private IOException startFailure;
        private IOException readFailure;
        private IOException closeFailure;
        private String response = "{\"jsonrpc\":\"2.0\",\"error\":{\"code\":-32603,"
                + "\"message\":\"fixture initialization rejected\"}}";

        @Override
        public boolean isReading() { return false; }

        @Override
        public void start() throws IOException {
            starts++;
            if (startFailure != null) {
                throw startFailure;
            }
        }

        @Override
        public void close() throws IOException {
            closes++;
            if (closeFailure != null) {
                throw closeFailure;
            }
        }

        @Override
        public boolean isAvailable() { return true; }

        @Override
        public String inputWaitForOneLine(String message) throws IOException {
            if (readFailure != null) {
                throw readFailure;
            }
            return response;
        }

        @Override
        public void inputWaitForMultiLine(String message, Function<String, Boolean> callback) {
            throw new AssertionError("Unexpected prompt");
        }

        @Override
        public void inputNoWaitResponse(String message) {
            throw new AssertionError("Unexpected notification");
        }
    }
}
