package com.alibaba.acp.sdk.transport.process;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.apache.commons.lang3.Validate;
import org.junit.jupiter.api.condition.DisabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.slf4j.Logger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

@DisabledOnOs(OS.WINDOWS)
class ProcessTransportEncodingTest {
    @TempDir
    Path tempDir;

    @ParameterizedTest
    @CsvSource({"US-ASCII, unicode", "US-ASCII, ascii", "UTF-8, unicode"})
    void preservesProtocolTextRegardlessOfDefaultCharset(String charset, String content) throws Exception {
        Path executable = tempDir.resolve("echo.sh");
        Files.write(executable, ("#!/bin/sh\n"
                + "IFS= read -r line\n"
                + "printf '%s\\n' \"$line\"\n"
                + "printf '%s\\n' \"$line\" >&2\n").getBytes(StandardCharsets.UTF_8));
        assertTrue(executable.toFile().setExecutable(true));
        String java = Paths.get(System.getProperty("java.home"), "bin", "java").toString();
        Process probe = new ProcessBuilder(java, "-Dfile.encoding=" + charset,
                "-cp", probeClasspath(), EncodingProbe.class.getName(), executable.toString(), content)
                .redirectErrorStream(true).start();
        try {
            assertTrue(probe.waitFor(10, TimeUnit.SECONDS));
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            try (InputStream input = probe.getInputStream()) {
                byte[] buffer = new byte[1024];
                int length;
                while ((length = input.read(buffer)) != -1) {
                    output.write(buffer, 0, length);
                }
            }
            assertEquals(0, probe.exitValue(), new String(output.toByteArray(), StandardCharsets.UTF_8));
        } finally {
            probe.destroyForcibly();
            probe.waitFor(3, TimeUnit.SECONDS);
        }
    }

    private static String probeClasspath() throws Exception {
        Set<String> paths = new LinkedHashSet<>();
        for (Class<?> type : new Class<?>[] {
                ProcessTransportEncodingTest.class, ProcessTransport.class, Validate.class, Logger.class}) {
            paths.add(Paths.get(type.getProtectionDomain().getCodeSource().getLocation().toURI()).toString());
        }
        return String.join(File.pathSeparator, paths);
    }

    public static final class EncodingProbe {
        public static void main(String[] args) throws Exception {
            String content = "ascii".equals(args[1]) ? "ordinary ASCII" : "\u6b22\u8fce\ud83d\ude42";
            AtomicReference<String> stderr = new AtomicReference<>();
            CountDownLatch received = new CountDownLatch(1);
            ProcessTransport transport = new ProcessTransport(
                    new ProcessTransportOptions().setCommandArgs(new String[] {args[0]}).setErrorHandler(line -> {
                        stderr.set(line);
                        received.countDown();
                    }));
            transport.start();
            try {
                String stdout = transport.inputWaitForOneLine(content);
                if (!received.await(3, TimeUnit.SECONDS)) {
                    throw new AssertionError("stderr text was not delivered");
                }
                if (!content.equals(stdout) || !content.equals(stderr.get())) {
                    throw new AssertionError("UTF-8 text was changed in a process stream");
                }
            } finally {
                transport.process.destroyForcibly();
                transport.process.waitFor(3, TimeUnit.SECONDS);
                transport.close();
            }
        }
    }
}
