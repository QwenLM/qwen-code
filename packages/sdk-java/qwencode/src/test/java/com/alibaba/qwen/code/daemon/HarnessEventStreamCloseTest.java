package com.alibaba.qwen.code.daemon;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

// A Hosted Harness that died behind a partition (or whose pod moved to
// another node) leaves the client side of its SSE stream half-open: the
// read never returns. next() holds the stream's lock across that read,
// so a close() that waited for the lock wedged for good — and with it
// every generation adoption, which closes the stale client and its
// streams. Each close here runs on its own thread with a bounded join,
// so a regression fails instead of hanging the suite; the teardown then
// ends the held body, which also releases a wedged closer.
class HarnessEventStreamCloseTest {
    private static final String FRAME = "id: 1\nevent: status\n"
            + "data: {\"v\":1,\"type\":\"status\",\"id\":1,\"data\":{}}\n\n";

    private HeldStreamHarness harness;

    @BeforeEach
    void setUp() throws IOException {
        harness = HeldStreamHarness.start();
    }

    @AfterEach
    void tearDown() {
        if (harness != null) {
            harness.stop();
        }
    }

    // The generation adoption's path: closing the stale client closes
    // the stream a Turn's reader is blocked on.
    @Test
    @Timeout(60)
    void closingTheClientEndsAReadBlockedOnAHalfOpenStream()
            throws Exception {
        assertCloseEndsTheBlockedRead(HostedHarnessClient::close, null);
    }

    @Test
    @Timeout(60)
    void closingTheStreamEndsAReadBlockedOnAHalfOpenStream()
            throws Exception {
        AtomicReference<HarnessEventStream> opened = new AtomicReference<>();
        assertCloseEndsTheBlockedRead(client -> opened.get().close(),
                opened);
    }

    // A close that lands while next() already holds a whole frame: the
    // frame is dropped rather than delivered off a closed stream, so the
    // read position does not move — and the parked consumer gets the same
    // transport signal as a read the close interrupted on the socket.
    @Test
    @Timeout(60)
    void aCloseRacingABufferedFrameReportsTheStreamClosed()
            throws Exception {
        assertCloseRacingTheReadReportsClosed(FRAME);
    }

    // A close that lands as the body ends: the reader sees the close with
    // the same transport signal, not the server ending the stream, which a
    // consumer reads as an early end.
    @Test
    @Timeout(60)
    void aCloseRacingTheEndOfTheBodyReportsTheStreamClosed()
            throws Exception {
        assertCloseRacingTheReadReportsClosed("");
    }

    // A frame the reader pulls in the tick the idle watchdog commits to
    // close is discarded with the idle-timeout signal the interrupted read
    // would have raised — not the programming-error type — so the
    // consumer's idle-reconnect branch still fires.
    @Test
    @Timeout(60)
    void anIdleAbortRacingABufferedFrameReportsTheIdleTimeout()
            throws Exception {
        HostedHarnessClient client = HostedHarnessClient.builder()
                .baseUri(harness.baseUri())
                .bearerToken("harness-token")
                .capabilityDigest(HeldStreamHarness.DIGEST)
                .sseIdleTimeout(Duration.ofMillis(200))
                .build();
        try {
            HarnessSessionRef session = client.createSession(
                    CreateHarnessSession.builder()
                            .harnessSessionId(HeldStreamHarness.SESSION_ID)
                            .build());
            HarnessEventStream stream = new HarnessEventStream(client,
                    session, new DeliverOnClose(FRAME), 1 << 20, 0,
                    HeldStreamHarness.EVENT_EPOCH);
            stream.startIdleWatchdog();
            HostedHarnessStreamIdleException idle = assertThrows(
                    HostedHarnessStreamIdleException.class, stream::next);
            assertEquals("Hosted Harness SSE idle timeout",
                    idle.getMessage());
            assertEquals(0, stream.getLastEventId());
        } finally {
            client.close();
        }
    }

    private void assertCloseRacingTheReadReportsClosed(String body)
            throws Exception {
        HostedHarnessClient client = harness.client();
        try {
            HarnessSessionRef session = client.createSession(
                    CreateHarnessSession.builder()
                            .harnessSessionId(HeldStreamHarness.SESSION_ID)
                            .build());
            AtomicReference<HarnessEventStream> opened =
                    new AtomicReference<>();
            HarnessEventStream stream = new HarnessEventStream(client,
                    session, new CloseOnFirstRead(body, opened), 1 << 20, 0,
                    HeldStreamHarness.EVENT_EPOCH);
            opened.set(stream);
            // The close raced the read, so the parked consumer gets the
            // same transport signal the interrupted read would have raised
            // — never the closed guard's programming-error type, which
            // stays reserved for a caller arriving after the close.
            DaemonTransportException closed = assertThrows(
                    DaemonTransportException.class, stream::next);
            assertEquals("HarnessEventStream is closed", closed.getMessage());
            assertEquals(0, stream.getLastEventId());
        } finally {
            client.close();
        }
    }

    private void assertCloseEndsTheBlockedRead(
            Consumer<HostedHarnessClient> close,
            AtomicReference<HarnessEventStream> opened) throws Exception {
        HostedHarnessClient client = harness.client();
        HarnessSessionRef session = client.createSession(
                CreateHarnessSession.builder()
                        .harnessSessionId(HeldStreamHarness.SESSION_ID)
                        .build());
        HarnessEventStream stream = client.streamEvents(
                StreamHarnessEvents.builder()
                        .session(session)
                        .lastEventId(0)
                        .eventEpoch(HeldStreamHarness.EVENT_EPOCH)
                        .build());
        if (opened != null) {
            opened.set(stream);
        }
        AtomicReference<Object> outcome = new AtomicReference<>();
        Thread reader = new Thread(() -> {
            try {
                outcome.set(stream.next());
            } catch (RuntimeException error) {
                outcome.set(error);
            }
        }, "half-open-reader");
        reader.setDaemon(true);
        reader.start();
        awaitParked(reader);

        // The read position stays readable while a read is blocked.
        Thread position = startDaemon("half-open-position",
                () -> stream.getLastEventId());
        position.join(TimeUnit.SECONDS.toMillis(10));
        assertFalse(position.isAlive(),
                "getLastEventId() waited on the blocked reader");

        Thread closer = startDaemon("half-open-close",
                () -> close.accept(client));
        closer.join(TimeUnit.SECONDS.toMillis(10));
        assertFalse(closer.isAlive(),
                "close() waited on the reader blocked on a half-open"
                        + " stream");
        reader.join(TimeUnit.SECONDS.toMillis(10));
        assertFalse(reader.isAlive(),
                "the blocked read did not end when its stream closed");
        // A local close is not the server ending the stream: the read
        // blocked on the socket is cut at the transport layer, so the
        // parked consumer gets a DaemonTransportException, while a
        // caller arriving after the close still gets the closed guard's
        // IllegalStateException.
        DaemonTransportException closed = assertInstanceOf(
                DaemonTransportException.class, outcome.get());
        assertEquals("HarnessEventStream is closed", closed.getMessage());
        client.close();
    }

    // The reader is inside next() once it parks on the empty body.
    private static void awaitParked(Thread reader) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (reader.getState() != Thread.State.WAITING
                && reader.getState() != Thread.State.TIMED_WAITING) {
            assertTrue(System.nanoTime() < deadline,
                    "the reader never blocked on the stream: "
                            + reader.getState());
            Thread.sleep(10);
        }
        // Give a reader that parked anywhere else a chance to move on.
        Thread.sleep(200);
        assertTrue(reader.getState() == Thread.State.WAITING
                || reader.getState() == Thread.State.TIMED_WAITING);
    }

    private static Thread startDaemon(String name, Runnable task) {
        Thread thread = new Thread(task, name);
        thread.setDaemon(true);
        thread.start();
        return thread;
    }

    // A body whose first read closes the stream it feeds and still hands
    // over its bytes: the close lands inside next(), after the read began
    // and before the frame (or the end of the body) is acted on.
    private static final class CloseOnFirstRead extends InputStream {
        private final InputStream bytes;
        private final AtomicReference<HarnessEventStream> stream;
        private boolean closedTheStream;

        CloseOnFirstRead(String body,
                AtomicReference<HarnessEventStream> stream) {
            this.bytes = new ByteArrayInputStream(
                    body.getBytes(StandardCharsets.UTF_8));
            this.stream = stream;
        }

        @Override
        public int read() throws IOException {
            closeTheStreamOnce();
            return bytes.read();
        }

        @Override
        public int read(byte[] buffer, int offset, int length)
                throws IOException {
            closeTheStreamOnce();
            return bytes.read(buffer, offset, length);
        }

        private void closeTheStreamOnce() {
            if (!closedTheStream) {
                closedTheStream = true;
                stream.get().close();
            }
        }
    }

    // A body whose first read blocks until the stream is closed — the idle
    // watchdog's closeQuietly — and then delivers its bytes: the shape of a
    // frame landing in the reader's buffer inside the abort tick.
    private static final class DeliverOnClose extends InputStream {
        private final CountDownLatch closedLatch = new CountDownLatch(1);
        private final InputStream bytes;

        DeliverOnClose(String body) {
            this.bytes = new ByteArrayInputStream(
                    body.getBytes(StandardCharsets.UTF_8));
        }

        @Override
        public int read() throws IOException {
            awaitClosed();
            return bytes.read();
        }

        @Override
        public int read(byte[] buffer, int offset, int length)
                throws IOException {
            awaitClosed();
            return bytes.read(buffer, offset, length);
        }

        @Override
        public void close() {
            closedLatch.countDown();
        }

        private void awaitClosed() throws IOException {
            try {
                if (!closedLatch.await(30, TimeUnit.SECONDS)) {
                    throw new IOException("the stream was never closed");
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new IOException(e);
            }
        }
    }
}
