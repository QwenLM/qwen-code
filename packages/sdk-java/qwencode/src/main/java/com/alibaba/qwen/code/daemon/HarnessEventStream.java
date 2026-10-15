package com.alibaba.qwen.code.daemon;

import java.io.IOException;
import java.io.InputStream;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.locks.ReentrantLock;

/** One generation- and epoch-fenced Hosted Harness SSE stream. */
public final class HarnessEventStream implements AutoCloseable {
    private final HostedHarnessClient client;
    private final HarnessSessionRef session;
    private final InputStream input;
    private final SseReader reader;
    private final String eventEpoch;
    private volatile long lastEventId;
    // close() never takes the reader's lock: next() holds it across the
    // blocking SSE read, and closing the body is what ends that read. A
    // half-open connection never answers, so waiting for the lock first
    // wedged every close — a generation adoption's client close included.
    private final AtomicBoolean closed = new AtomicBoolean();
    // A monitor held across the blocking SSE read pins a virtual thread to
    // its carrier on JDK 21; a ReentrantLock lets the reader unmount.
    private final ReentrantLock lock = new ReentrantLock();

    HarnessEventStream(HostedHarnessClient client, HarnessSessionRef session,
            InputStream input, int maximumFrameBytes, long lastEventId,
            String eventEpoch) {
        this.client = client;
        this.session = session;
        this.input = input;
        this.reader = new SseReader(input, maximumFrameBytes, () -> {
            // This transport does not own an idle watchdog.
        });
        this.lastEventId = lastEventId;
        this.eventEpoch = eventEpoch;
    }

    public String getEventEpoch() {
        return eventEpoch;
    }

    public long getLastEventId() {
        return lastEventId;
    }

    public DaemonEvent next() {
        lock.lock();
        try {
            ensureOpen();
            try {
                SseReader.Frame frame = reader.next();
                // A close() that raced this read (a buffered frame, or the
                // end of the body) reports as closed, not as an event or
                // as the server ending the stream.
                ensureOpen();
                if (frame == null) {
                    close();
                    return null;
                }
                DaemonEvent event = DaemonSessionClient.parseEvent(frame);
                Long eventId = event.getId();
                if (eventId != null) {
                    if (eventId <= lastEventId) {
                        throw new DaemonProtocolException(
                                "Hosted Harness SSE event ID moved backward or repeated");
                    }
                    if (eventId != lastEventId + 1) {
                        throw new DaemonProtocolException(
                                "Hosted Harness SSE event ID gap: expected "
                                        + (lastEventId + 1) + " but received "
                                        + eventId);
                    }
                    lastEventId = eventId;
                }
                client.observeEvent(session, event);
                return event;
            } catch (IOException e) {
                if (closed.get()) {
                    // close() ended the blocked read.
                    throw new IllegalStateException(
                            "HarnessEventStream is closed", e);
                }
                closeQuietly();
                throw new DaemonTransportException(
                        "Hosted Harness SSE stream failed", e);
            } catch (RuntimeException e) {
                closeQuietly();
                throw e;
            }
        } finally {
            lock.unlock();
        }
    }

    @Override
    public void close() {
        if (!closed.compareAndSet(false, true)) {
            return;
        }
        client.unregisterStream(this);
        try {
            input.close();
        } catch (IOException e) {
            throw new DaemonTransportException(
                    "Hosted Harness SSE stream could not be closed", e);
        }
    }

    void closeQuietly() {
        try {
            close();
        } catch (DaemonException ignored) {
            // Local transport shutdown is best-effort during client close.
        }
    }

    private void ensureOpen() {
        if (closed.get()) {
            throw new IllegalStateException(
                    "HarnessEventStream is closed");
        }
    }
}
