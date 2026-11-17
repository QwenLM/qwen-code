package com.alibaba.qwen.code.cli;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONObject;
import com.alibaba.qwen.code.cli.session.Session;
import com.alibaba.qwen.code.cli.transport.TransportOptions;
import com.alibaba.qwen.code.cli.utils.Timeout;
import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.DisabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

@DisabledOnOs(OS.WINDOWS)
class ClientInitializationCleanupTest {
    @TempDir
    Path temporary;

    @Test
    void initializationTimeoutTerminatesTheOwnedChild() throws Exception {
        Path pidFile = temporary.resolve("child.pid");
        try {
            RuntimeException failure = assertThrows(RuntimeException.class,
                    () -> QwenCodeCli.newSession(options("timeout", pidFile)));

            assertTrue(failure.getMessage().contains("initialized Session error"));
            assertNotNull(failure.getCause());
            assertNotNull(failure.getCause().getCause());
            ProcessHandle child = child(pidFile);
            if (child != null) {
                long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
                while (child.isAlive() && System.nanoTime() < deadline) {
                    Thread.sleep(5);
                }
                assertFalse(child.isAlive(), "Failed initialization must release the owned process");
            }
        } finally {
            terminateFixture(pidFile);
        }
    }

    @Test
    void successfulInitializationKeepsTheChildUntilExplicitClose() throws Exception {
        Path pidFile = temporary.resolve("child.pid");
        Session session = null;
        try {
            session = QwenCodeCli.newSession(options("success", pidFile));
            ProcessHandle child = child(pidFile);
            assertNotNull(child);
            assertTrue(child.isAlive());

            session.close();
            child.onExit().get(3, TimeUnit.SECONDS);
            assertFalse(child.isAlive());
        } finally {
            terminateFixture(pidFile);
            if (session != null) {
                session.close();
            }
        }
    }

    private TransportOptions options(String mode, Path pidFile) throws Exception {
        String classpath = Paths.get(ClientInitializationCleanupTest.class.getProtectionDomain().getCodeSource().getLocation().toURI())
                + File.pathSeparator + Paths.get(JSON.class.getProtectionDomain().getCodeSource().getLocation().toURI());
        String java = Paths.get(System.getProperty("java.home"), "bin", "java").toString();
        Path script = temporary.resolve("initialize-peer.sh");
        Files.write(script, ("#!/bin/sh\nexec " + quote(java) + " -cp " + quote(classpath) + " "
                + quote(InitializationPeer.class.getName()) + " " + mode + " " + quote(pidFile.toString()) + "\n")
                .getBytes(StandardCharsets.UTF_8));
        assertTrue(script.toFile().setExecutable(true));
        return new TransportOptions().setPathToQwenExecutable(script.toString())
                .setTurnTimeout(new Timeout(1L, TimeUnit.SECONDS));
    }

    private static String quote(String value) {
        return "'" + value.replace("'", "'\"'\"'") + "'";
    }

    private static ProcessHandle child(Path pidFile) throws Exception {
        return ProcessHandle.of(Long.parseLong(Files.readString(pidFile).trim())).orElse(null);
    }

    private static void terminateFixture(Path pidFile) throws Exception {
        if (Files.exists(pidFile)) {
            ProcessHandle child = child(pidFile);
            if (child != null && child.isAlive()) {
                child.destroyForcibly();
                child.onExit().get(3, TimeUnit.SECONDS);
            }
        }
    }

    public static final class InitializationPeer {
        public static void main(String[] args) throws Exception {
            Files.writeString(Paths.get(args[1]), Long.toString(ProcessHandle.current().pid()));
            BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
            JSONObject request = JSON.parseObject(input.readLine());
            if ("success".equals(args[0])) {
                JSONObject response = JSON.parseObject("{\"type\":\"control_response\",\"response\":{\"subtype\":\"success\","
                        + "\"response\":{\"subtype\":\"initialize\",\"capabilities\":{}}}}");
                response.getJSONObject("response").put("request_id", request.get("request_id"));
                System.out.println(response);
            }
            new CountDownLatch(1).await();
        }
    }
}
