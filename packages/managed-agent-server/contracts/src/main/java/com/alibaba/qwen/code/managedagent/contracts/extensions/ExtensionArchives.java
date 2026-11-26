package com.alibaba.qwen.code.managedagent.contracts.extensions;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Path;
import java.util.concurrent.atomic.AtomicBoolean;

public interface ExtensionArchives {
    public boolean configured();
    public long put(String tenant, String workspace, String digest, InputStream archive) throws IOException;
    public Archive verify(String tenant, String workspace, String digest, long expectedLength) throws IOException;

    final class Archive implements AutoCloseable {
        private final Path path;
        private final Runnable release;
        private final AtomicBoolean closed = new AtomicBoolean();
        public Archive(Path path, Runnable release) {
            this.path = path;
            this.release = release;
        }
        public Path path() { return path; }
        @Override public void close() {
            if (closed.compareAndSet(false, true)) {
                release.run();
            }
        }
    }
}
