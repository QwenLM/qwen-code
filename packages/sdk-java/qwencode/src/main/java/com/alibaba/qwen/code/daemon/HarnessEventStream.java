package com.alibaba.qwen.code.daemon;

import java.io.IOException;
import java.io.InputStream;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.locks.ReentrantLock;

/** One generation- and epoch-fenced Hosted Harness SSE stream. */
public final class HarnessEventStream implements AutoCloseable {
    private final HostedHarnessClient client;
    private final HarnessSessionRef session;
    private final InputStream input;
    private final SseReader reader;
    private final String eventEpoch;
    private final AtomicBoolean closed = new AtomicBoolean();
    private final AtomicBoolean idleTimedOut = new AtomicBoolean();
    private final AtomicLong lastActivity =
            new AtomicLong(System.nanoTime());
    private final AtomicBoolean consumerWaiting = new AtomicBoolean();
    // Serializes concurrent next() callers so frames cannot interleave;
    // close() never takes this lock, so a blocked read stays abortable. A
    // monitor held across the blocking SSE read would pin a virtual thread
    // to its carrier on JDK 21; a ReentrantLock lets the reader unmount.
    private final ReentrantLock cursorLock = new ReentrantLock();
    private volatile ScheduledFuture<?> idleWatchdog;
    private volatile long lastEventId;

    HarnessEventStream(HostedHarnessClient client, HarnessSessionRef session,
            InputStream input, int maximumFrameBytes, long lastEventId,
            String eventEpoch) {
        this.client = client;
        this.session = session;
        this.input = input;
        this.reader = new SseReader(input, maximumFrameBytes,
                () -> lastActivity.set(System.nanoTime()));
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
        if (closed.get()) {
            throw closedFailure();
        }
        cursorLock.lock();
        try {
            // A queued caller re-checks inside the lock: the stream may
            // have been closed (or idle-aborted) while it waited.
            if (closed.get()) {
                throw closedFailure();
            }
            // The idle budget measures peer silence while a consumer is
            // parked here; time between next() calls is not charged.
            consumerWaiting.set(true);
            lastActivity.set(System.nanoTime());
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
                if (idleTimedOut.get()) {
                    throw new DaemonTransportException(
                            "Hosted Harness SSE idle timeout", e);
                }
                throw new DaemonTransportException(
                        "Hosted Harness SSE stream failed", e);
            } catch (RuntimeException e) {
                closeQuietly();
                throw e;
            } finally {
                consumerWaiting.set(false);
            }
        } finally {
            cursorLock.unlock();
        }
    }

    @Override
    public void close() {
        if (!closed.compareAndSet(false, true)) {
            return;
        }
        ScheduledFuture<?> watchdog = idleWatchdog;
        if (watchdog != null) {
            watchdog.cancel(false);
        }
        try {
            input.close();
        } catch (IOException e) {
            throw new DaemonTransportException(
                    "Hosted Harness SSE stream could not be closed", e);
        } finally {
            client.unregisterStream(this);
        }
    }

    void closeQuietly() {
        try {
            close();
        } catch (DaemonException ignored) {
            // Local transport shutdown is best-effort during client close.
        }
    }

    private RuntimeException closedFailure() {
        if (idleTimedOut.get()) {
            return new DaemonTransportException(
                    "Hosted Harness SSE idle timeout");
        }
        return new IllegalStateException(
                "HarnessEventStream is closed");
    }

    void startIdleWatchdog() {
        if (client.sseIdleTimeout().isZero()) {
            // Builder.sseIdleTimeout(Duration.ZERO): the caller owns the
            // deadline, so no watchdog is scheduled.
            return;
        }
        long idleMillis = HostedHarnessClient.saturatedMillis(
                client.sseIdleTimeout());
        long intervalMillis = Math.max(100L, idleMillis / 2L);
        long idleNanos = TimeUnit.MILLISECONDS.toNanos(idleMillis);
        idleWatchdog = client.scheduler().scheduleAtFixedRate(() -> {
            if (closed.get()) {
                ScheduledFuture<?> watchdog = idleWatchdog;
                if (watchdog != null) {
                    watchdog.cancel(false);
                }
                return;
            }
            // Only a consumer parked in next() is waiting on the peer; a
            // stream nobody is pulling stays open until close().
            if (!consumerWaiting.get()) {
                return;
            }
            if (System.nanoTime() - lastActivity.get() >= idleNanos
                    && idleTimedOut.compareAndSet(false, true)) {
                // Closes the raw input without any stream monitor, so the
                // single-thread scheduler never blocks behind the reader.
                closeQuietly();
            }
        }, intervalMillis, intervalMillis, TimeUnit.MILLISECONDS);
    }
}
