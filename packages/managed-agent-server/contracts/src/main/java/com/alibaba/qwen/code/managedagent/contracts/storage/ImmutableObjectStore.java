package com.alibaba.qwen.code.managedagent.contracts.storage;

import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;

/** Private durable objects; ordering, reference ownership and write reconciliation belong to SQL. */
public interface ImmutableObjectStore extends AutoCloseable {
    /** Stable, non-secret identity of the physical namespace, independent of client credentials. */
    String identity();

    /** One physical create, without overwrite or hidden retries, even after an uncertain response. */
    void putIfAbsent(String key, InputStream source, long length, Runnable guard);

    /** The caller owns the stream; implementations check the guard before every backend request. */
    InputStream open(String key, Runnable guard);

    /** Bound every read, including retries performed by the underlying stream. */
    default InputStream open(String key, long maximumBytes, Runnable guard) {
        if (maximumBytes < 0) {
            throw new IllegalArgumentException("Negative object read limit");
        }
        guard.run();
        return new FilterInputStream(open(key, guard)) {
            private long remaining = maximumBytes;

            @Override
            public int read() throws IOException {
                byte[] one = new byte[1];
                return read(one, 0, 1) == -1 ? -1 : one[0] & 255;
            }

            @Override
            public int read(byte[] bytes, int offset, int length) throws IOException {
                guard.run();
                int count = in.read(bytes, offset, (int) Math.min(length, Math.min(65535, remaining) + 1));
                if (count > 0) {
                    remaining -= count;
                    if (remaining < 0) {
                        throw new IOException("Object exceeds its declared read limit");
                    }
                }
                return count;
            }

            @Override
            public long skip(long count) throws IOException {
                long skipped = 0;
                byte[] buffer = new byte[8192];
                while (skipped < count) {
                    int read = read(buffer, 0, (int) Math.min(buffer.length, count - skipped));
                    if (read == -1) {
                        break;
                    }
                    skipped += read;
                }
                return skipped;
            }

            @Override
            public boolean markSupported() {
                return false;
            }

            @Override
            public void reset() throws IOException {
                throw new IOException("Object streams do not support reset");
            }
        };
    }

    /** Delete the exact owned object; absence is success. */
    void deleteIfPresent(String key, Runnable guard);

    void validateConfiguration();

    @Override
    void close();
}
