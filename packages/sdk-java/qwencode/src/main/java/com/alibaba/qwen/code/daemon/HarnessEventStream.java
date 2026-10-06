package com.alibaba.qwen.code.daemon;

import java.io.IOException;
import java.io.InputStream;
import java.util.concurrent.locks.ReentrantLock;

/** One generation- and epoch-fenced Hosted Harness SSE stream. */
public final class HarnessEventStream implements AutoCloseable {
    private final HostedHarnessClient client;
    private final HarnessSessionRef session;
    private final InputStream input;
    private final SseReader reader;
    private final String eventEpoch;
    private long lastEventId;
    private boolean closed;
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
        lock.lock();
        try {
            return lastEventId;
        } finally {
            lock.unlock();
        }
    }

    public DaemonEvent next() {
        lock.lock();
        try {
            ensureOpen();
            try {
                SseReader.Frame frame = reader.next();
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
        lock.lock();
        try {
            if (closed) {
                return;
            }
            closed = true;
            client.unregisterStream(this);
            try {
                input.close();
            } catch (IOException e) {
                throw new DaemonTransportException(
                        "Hosted Harness SSE stream could not be closed", e);
            }
        } finally {
            lock.unlock();
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
        if (closed) {
            throw new IllegalStateException(
                    "HarnessEventStream is closed");
        }
    }
}
