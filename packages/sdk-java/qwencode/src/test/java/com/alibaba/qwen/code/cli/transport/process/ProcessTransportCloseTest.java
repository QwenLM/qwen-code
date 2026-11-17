package com.alibaba.qwen.code.cli.transport.process;

import com.alibaba.qwen.code.cli.transport.TransportOptions;
import java.io.BufferedReader;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import static org.junit.jupiter.api.Assertions.assertTrue;

class ProcessTransportCloseTest {
    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void closesChildWhileAReaderIsBlocked(boolean stderr) throws Exception {
        Process child = startChild("wait");
        FixtureTransport transport = new FixtureTransport();
        transport.process = child;
        CountDownLatch reading = new CountDownLatch(1);
        InputStream input = stderr ? child.getErrorStream() : child.getInputStream();
        BufferedReader reader = new BufferedReader(new InputStreamReader(new FilterInputStream(input) {
            @Override
            public int read(byte[] bytes, int offset, int length) throws IOException {
                reading.countDown();
                return super.read(bytes, offset, length);
            }
        }, StandardCharsets.UTF_8));
        if (stderr) {
            transport.processError = reader;
        } else {
            transport.processOutput = reader;
        }
        ExecutorService executor = Executors.newFixedThreadPool(2, task -> {
            Thread thread = new Thread(task);
            thread.setDaemon(true);
            return thread;
        });
        try {
            Future<?> read = executor.submit(() -> {
                try {
                    reader.readLine();
                } catch (IOException ignored) {
                    // Closing the process may end a blocked read with an I/O error.
                }
            });
            assertTrue(reading.await(3, TimeUnit.SECONDS));
            Future<?> close = executor.submit(() -> {
                transport.close();
                return null;
            });

            close.get(3, TimeUnit.SECONDS);
            assertTrue(child.waitFor(3, TimeUnit.SECONDS));
            read.get(3, TimeUnit.SECONDS);
        } finally {
            child.destroyForcibly();
            child.waitFor(3, TimeUnit.SECONDS);
            executor.shutdownNow();
            reader.close();
        }
    }

    @Test
    void closesAnAlreadyExitedChild() throws Exception {
        Process child = startChild("exit");
        FixtureTransport transport = new FixtureTransport();
        transport.process = child;
        try {
            assertTrue(child.waitFor(3, TimeUnit.SECONDS));
            transport.close();
        } finally {
            child.destroyForcibly();
        }
    }

    private static Process startChild(String mode) throws Exception {
        String java = Path.of(System.getProperty("java.home"), "bin", "java").toString();
        String classes = Path.of(WaitingChild.class.getProtectionDomain().getCodeSource()
                .getLocation().toURI()).toString();
        return new ProcessBuilder(java, "-cp", classes, WaitingChild.class.getName(), mode).start();
    }

    private static final class FixtureTransport extends ProcessTransport {
        FixtureTransport() throws IOException {
            super(new TransportOptions());
        }

        @Override
        public void start() {
            // The test supplies a real process with a deterministically blocked reader.
        }
    }

    public static final class WaitingChild {
        public static void main(String[] args) throws InterruptedException {
            if ("wait".equals(args[0])) {
                new CountDownLatch(1).await();
            }
        }
    }
}
