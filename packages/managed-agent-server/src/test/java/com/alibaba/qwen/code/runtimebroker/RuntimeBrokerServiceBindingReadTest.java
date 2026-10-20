package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.net.URI;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;

/** The live-binding-only read the relay and the cascade bond to. */
class RuntimeBrokerServiceBindingReadTest {

    private static <T> T stub(Class<T> iface) {
        return iface.cast(Proxy.newProxyInstance(iface.getClassLoader(),
                new Class<?>[] {iface}, (proxy, method, args) -> {
                    throw new UnsupportedOperationException(method.getName());
                }));
    }

    private static RuntimeBindingRecord row(String bindingId,
            RuntimeBindingRecord.State state) {
        return new RuntimeBindingRecord(bindingId,
                new RuntimeProvisionRequest(new RuntimeScope("tenant",
                        "workspace", "generation", "/cwd",
                        "d".repeat(64), "session"), "session"),
                1, state,
                new RuntimeLease("runtime-1", URI.create("http://127.0.0.1/"),
                        "token", "lease-1", 0),
                false, null, null, 0, 1, Instant.EPOCH, Instant.EPOCH);
    }

    @Test
    void answersTheNewestReadyBindingNeverAnInertOne() {
        AtomicReference<List<RuntimeBindingRecord>> rows =
                new AtomicReference<>(List.of());
        InvocationHandler handler = (proxy, method, args) -> {
            if ("findByHarnessSession".equals(method.getName())) {
                List<RuntimeBindingRecord> all = rows.get();
                String after = (String) args[2];
                int limit = (Integer) args[3];
                int start = 0;
                while (start < all.size() && after != null && !after.isEmpty()
                        && all.get(start).getBindingId().compareTo(after) <= 0) {
                    start++;
                }
                return all.subList(start,
                        Math.min(all.size(), start + limit));
            }
            throw new UnsupportedOperationException(method.getName());
        };
        RuntimeBindingRepository bindings = (RuntimeBindingRepository)
                Proxy.newProxyInstance(
                        RuntimeBindingRepository.class.getClassLoader(),
                        new Class<?>[] {RuntimeBindingRepository.class},
                        handler);
        RuntimeBrokerService service = new RuntimeBrokerService(
                stub(HarnessSessionResolver.class),
                stub(RuntimeProvisioner.class), stub(RuntimeTransport.class),
                bindings, stub(RuntimeSessionRepository.class),
                stub(ToolExecutionRepository.class), "owner",
                Duration.ofSeconds(30), Duration.ofSeconds(30));
        RuntimeBindingRecord inert = row("zzz", RuntimeBindingRecord.State.LOST);
        RuntimeBindingRecord ready = row("aaa", RuntimeBindingRecord.State.READY);
        rows.set(List.of(inert, ready));
        // A lexically-greater inert id must not beat the older READY row.
        assertSame(ready, service.findLatestBindingByHarnessSession("tenant",
                "session"));
        // Nothing READY? Meant nothing.
        rows.set(List.of(inert));
        assertNull(service.findLatestBindingByHarnessSession("tenant",
                "session"));
        // Two READY rows spanning the page boundary, lower id first:
        // the new Javadoc's rule wins — "the newest READY id wins across
        // pages", never the first page that holds any READY row.
        RuntimeBindingRecord readyLow = row("0000a",
                RuntimeBindingRecord.State.READY);
        RuntimeBindingRecord readyHigh = row("zzzz0",
                RuntimeBindingRecord.State.READY);
        List<RuntimeBindingRecord> spanning = new ArrayList<>();
        spanning.add(readyLow);
        for (int index = 0; index < 120; index++) {
            spanning.add(row(String.format("%04x-mid", index + 1),
                    RuntimeBindingRecord.State.LOST));
        }
        spanning.add(readyHigh);
        rows.set(spanning);
        assertSame(readyHigh, service.findLatestBindingByHarnessSession("tenant",
                "session"));
    }

    /** The evidence read: any state's newest id across the whole
     * traversal — a retired binding still proves its dispatch. */
    @Test
    void answersTheNewestBindingAcrossPagesInAnyState() {
        AtomicReference<List<RuntimeBindingRecord>> rows =
                new AtomicReference<>(List.of());
        InvocationHandler handler = (proxy, method, args) -> {
            if ("findByHarnessSession".equals(method.getName())) {
                List<RuntimeBindingRecord> all = rows.get();
                String after = (String) args[2];
                int limit = (Integer) args[3];
                int start = 0;
                while (start < all.size() && after != null && !after.isEmpty()
                        && all.get(start).getBindingId().compareTo(after) <= 0) {
                    start++;
                }
                return all.subList(start,
                        Math.min(all.size(), start + limit));
            }
            throw new UnsupportedOperationException(method.getName());
        };
        RuntimeBindingRepository bindings = (RuntimeBindingRepository)
                Proxy.newProxyInstance(
                        RuntimeBindingRepository.class.getClassLoader(),
                        new Class<?>[] {RuntimeBindingRepository.class},
                        handler);
        RuntimeBrokerService service = new RuntimeBrokerService(
                stub(HarnessSessionResolver.class),
                stub(RuntimeProvisioner.class), stub(RuntimeTransport.class),
                bindings, stub(RuntimeSessionRepository.class),
                stub(ToolExecutionRepository.class), "owner",
                Duration.ofSeconds(30), Duration.ofSeconds(30));
        RuntimeBindingRecord releasedHigh = row("zzzz0",
                RuntimeBindingRecord.State.RELEASED);
        List<RuntimeBindingRecord> spanning = new ArrayList<>();
        spanning.add(row("0000a", RuntimeBindingRecord.State.READY));
        for (int index = 0; index < 120; index++) {
            spanning.add(row(String.format("%04x-mid", index + 1),
                    RuntimeBindingRecord.State.LOST));
        }
        spanning.add(releasedHigh);
        rows.set(spanning);
        assertSame(releasedHigh,
                service.findLatestBindingByHarnessSessionAnyState("tenant",
                        "session"));
        // An all-retired history is a full answer, never an absence.
        RuntimeBindingRecord lost = row("0000a",
                RuntimeBindingRecord.State.LOST);
        rows.set(List.of(lost));
        assertSame(lost,
                service.findLatestBindingByHarnessSessionAnyState("tenant",
                        "session"));
        // Only an empty history means nothing ever stood there.
        rows.set(List.of());
        assertNull(service.findLatestBindingByHarnessSessionAnyState(
                "tenant", "session"));
    }
}
