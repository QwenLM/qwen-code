package example;

import com.alibaba.qwen.code.managedagent.contracts.storage.ImmutableObjectStore;
import com.alibaba.qwen.code.managedagent.contracts.storage.ImmutableObjectStores;
import com.alibaba.qwen.code.managedagent.contracts.storage.ObjectStorageException;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/** Run only against a disposable namespace; backend fault qualification is a separate gate. */
public final class ObjectStoreContractCheck {
    private ObjectStoreContractCheck() { }

    public static void main(String[] args) throws Exception {
        if (args.length != 1) {
            throw new IllegalArgumentException("Usage: ObjectStoreContractCheck <provider>; options: -Dobject-store.option.<key>=<value>");
        }
        Map<String, String> options = new HashMap<>();
        System.getProperties().forEach((key, value) -> {
            String name = key.toString();
            if (name.startsWith("object-store.option.")) {
                options.put(name.substring("object-store.option.".length()), value.toString());
            }
        });
        var factories = new ImmutableObjectStores();
        String key = "contract-check/" + UUID.randomUUID();
        byte[] expected = new byte[65537];
        Arrays.fill(expected, (byte) 37);
        String identity;
        try (var store = factories.create(args[0], options)) {
            identity = store.identity();
            verify(store, key, expected);
        }
        try (var reopened = factories.create(args[0], options)) {
            require(identity.equals(reopened.identity()), "Namespace identity changed across restart");
            try (var input = reopened.open(key, expected.length, () -> {})) {
                require(Arrays.equals(expected, input.readAllBytes()), "Restart lost committed bytes");
            }
            reopened.deleteIfPresent(key, () -> {});
            reopened.deleteIfPresent(key, () -> {});
            expect(ObjectStorageException.Reason.NOT_FOUND, () -> {
                try (var input = reopened.open(key, () -> {})) {
                    input.read();
                }
            });
        }
        System.out.println("Immutable create/read/restart/delete contract passed; real fault qualification remains required.");
    }

    public static void verify(ImmutableObjectStore store, String key, byte[] expected) throws Exception {
        var start = new CountDownLatch(1);
        var successes = new AtomicInteger();
        try (var pool = Executors.newFixedThreadPool(2)) {
            var first = pool.submit(() -> create(store, key, expected, start, successes));
            var second = pool.submit(() -> create(store, key, expected, start, successes));
            start.countDown();
            first.get();
            second.get();
        }
        require(successes.get() == 1, "Concurrent creates did not have exactly one winner");
        expect(ObjectStorageException.Reason.ALREADY_EXISTS,
                () -> store.putIfAbsent(key, new ByteArrayInputStream(new byte[]{9}), 1, () -> {}));
        try (var input = store.open(key, expected.length, () -> {})) {
            require(Arrays.equals(expected, input.readAllBytes()), "Existing bytes were overwritten");
        }
        var revoked = new AtomicBoolean();
        Runnable guard = () -> {
            if (revoked.get()) {
                throw new IllegalStateException("revoked");
            }
        };
        try (var input = store.open(key, expected.length, guard)) {
            revoked.set(true);
            try {
                input.read();
                throw new AssertionError("Read ignored lease revocation");
            } catch (IllegalStateException failure) {
                require("revoked".equals(failure.getMessage()), "Unexpected read failure");
            }
        }
        try (var input = store.open(key, expected.length - 1L, () -> {})) {
            try {
                input.readAllBytes();
                throw new AssertionError("Read ignored its byte limit");
            } catch (IOException expectedLimit) {
                // The bounded contract, not the backend stream, owns this limit.
            }
        }
        String partial = key + "/partial";
        try {
            store.putIfAbsent(partial, new InputStream() {
                @Override public int read() throws IOException { throw new IOException("injected source failure"); }
            }, 1, () -> {});
            throw new AssertionError("Incomplete create reported success");
        } catch (ObjectStorageException expectedFailure) {
            expect(ObjectStorageException.Reason.NOT_FOUND, () -> {
                try (var input = store.open(partial, () -> {})) {
                    input.read();
                }
            });
        }
    }

    private static void create(ImmutableObjectStore store, String key, byte[] bytes, CountDownLatch start, AtomicInteger successes) {
        try {
            start.await();
            store.putIfAbsent(key, new ByteArrayInputStream(bytes), bytes.length, () -> {});
            successes.incrementAndGet();
        } catch (ObjectStorageException failure) {
            require(failure.reason() == ObjectStorageException.Reason.ALREADY_EXISTS, "Unexpected create failure");
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(interrupted);
        }
    }

    private static void expect(ObjectStorageException.Reason reason, Checked action) throws Exception {
        try {
            action.run();
            throw new AssertionError("Expected object error: " + reason);
        } catch (ObjectStorageException failure) {
            require(failure.reason() == reason, "Unexpected object error: " + failure.reason());
        }
    }

    private static void require(boolean value, String message) {
        if (!value) {
            throw new AssertionError(message);
        }
    }

    private interface Checked { void run() throws Exception; }
}
