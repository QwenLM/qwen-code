package com.alibaba.qwen.code.cli.transport.process;

import com.alibaba.qwen.code.cli.transport.TransportOptions;
import com.alibaba.fastjson2.JSON;
import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

@DisabledOnOs(OS.WINDOWS)
class ProcessTransportFramingTest {
    @TempDir
    Path temporary;

    @Test
    void concurrentWritersPreserveCompleteMessages() throws Exception {
        exchangeMessages(8, 512);
    }

    @Test
    void sequentialMessagesKeepTheirLineBoundaries() throws Exception {
        exchangeMessages(1, 20);
    }

    @Test
    void closedInputStillReportsWriteFailure() throws Exception {
        ProcessTransport transport = startPeer(0);
        try {
            transport.processInput.close();
            assertThrows(IOException.class, () -> transport.inputNoWaitResponse("{}"));
        } finally {
            finish(transport);
        }
    }

    private void exchangeMessages(int workers, int perWorker) throws Exception {
        int count = workers * perWorker;
        ProcessTransport transport = startPeer(count);
        ExecutorService senders = Executors.newFixedThreadPool(workers);
        CyclicBarrier ready = new CyclicBarrier(workers);
        List<Future<?>> writes = new ArrayList<>();
        try {
            for (int worker = 0; worker < workers; worker++) {
                final int workerId = worker;
                writes.add(senders.submit(() -> {
                    ready.await();
                    for (int item = 0; item < perWorker; item++) {
                        transport.inputNoWaitResponse("{\"id\":" + (workerId * perWorker + item) + "}");
                    }
                    return null;
                }));
            }
            for (Future<?> write : writes) {
                write.get(10, TimeUnit.SECONDS);
            }
            assertTrue(transport.process.waitFor(5, TimeUnit.SECONDS), "Peer must consume every line");
            assertEquals(count + ":0:" + count, transport.processOutput.readLine(), "valid:invalid:unique messages");
        } finally {
            senders.shutdownNow();
            finish(transport);
        }
    }

    private ProcessTransport startPeer(int count) throws Exception {
        String classpath = Paths.get(ProcessTransportFramingTest.class.getProtectionDomain().getCodeSource().getLocation().toURI())
                + File.pathSeparator + Paths.get(JSON.class.getProtectionDomain().getCodeSource().getLocation().toURI());
        String java = Paths.get(System.getProperty("java.home"), "bin", "java").toString();
        Path script = temporary.resolve("jsonl-peer.sh");
        Files.write(script, ("#!/bin/sh\nexec " + quote(java) + " -cp " + quote(classpath) + " "
                + quote(JsonlPeer.class.getName()) + " " + count + "\n").getBytes(StandardCharsets.UTF_8));
        assertTrue(script.toFile().setExecutable(true));
        ProcessTransport transport = new ProcessTransport(new TransportOptions().setPathToQwenExecutable(script.toString()), line -> {});
        return transport;
    }

    private static String quote(String value) {
        return "'" + value.replace("'", "'\"'\"'") + "'";
    }

    private static void finish(ProcessTransport transport) throws Exception {
        transport.process.destroyForcibly();
        assertTrue(transport.process.waitFor(5, TimeUnit.SECONDS));
        transport.close();
    }

    public static final class JsonlPeer {
        public static void main(String[] args) throws IOException {
            BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
            int count = Integer.parseInt(args[0]);
            int valid = 0;
            int invalid = 0;
            Set<Integer> identifiers = new HashSet<>();
            for (int line = 0; line < count; line++) {
                try {
                    identifiers.add(JSON.parseObject(input.readLine()).getInteger("id"));
                    valid++;
                } catch (RuntimeException failure) {
                    invalid++;
                }
            }
            System.out.println(valid + ":" + invalid + ":" + identifiers.size());
        }
    }
}
