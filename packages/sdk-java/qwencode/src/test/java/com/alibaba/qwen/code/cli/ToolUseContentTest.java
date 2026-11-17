package com.alibaba.qwen.code.cli;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONObject;
import com.alibaba.qwen.code.cli.transport.TransportOptions;
import com.alibaba.qwen.code.cli.utils.Timeout;
import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.condition.DisabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

@DisabledOnOs(OS.WINDOWS)
class ToolUseContentTest {
    @TempDir
    Path temporary;

    @ParameterizedTest
    @ValueSource(strings = {"tool", "empty", "text"})
    void simpleQueryPreservesCompleteAssistantContent(String mode) throws Exception {
        Path pidFile = temporary.resolve("child.pid");
        try {
            List<String> result = QwenCodeCli.simpleQuery("ordinary fixture prompt", options(mode, pidFile));

            assertEquals(1, result.size());
            if ("text".equals(mode)) {
                assertEquals("text control", result.get(0));
            } else {
                String expected = "empty".equals(mode) ? "{}" : "{\"path\":\"src/example.ts\",\"recursive\":false}";
                assertEquals(JSON.parseObject(expected), JSON.parseObject(result.get(0)));
            }
        } finally {
            if (Files.exists(pidFile)) {
                ProcessHandle child = ProcessHandle.of(Long.parseLong(Files.readString(pidFile).trim())).orElse(null);
                if (child != null && child.isAlive()) {
                    child.destroyForcibly();
                    child.onExit().get(3, TimeUnit.SECONDS);
                }
            }
        }
    }

    private TransportOptions options(String mode, Path pidFile) throws Exception {
        String classpath = Paths.get(ToolUseContentTest.class.getProtectionDomain().getCodeSource().getLocation().toURI())
                + File.pathSeparator + Paths.get(JSON.class.getProtectionDomain().getCodeSource().getLocation().toURI());
        String java = Paths.get(System.getProperty("java.home"), "bin", "java").toString();
        Path script = temporary.resolve("tool-content-peer.sh");
        Files.write(script, ("#!/bin/sh\nexec " + quote(java) + " -cp " + quote(classpath) + " "
                + quote(ToolContentPeer.class.getName()) + " " + mode + " " + quote(pidFile.toString()) + "\n")
                .getBytes(StandardCharsets.UTF_8));
        assertTrue(script.toFile().setExecutable(true));
        return new TransportOptions().setPathToQwenExecutable(script.toString())
                .setTurnTimeout(new Timeout(2L, TimeUnit.SECONDS));
    }

    private static String quote(String value) {
        return "'" + value.replace("'", "'\"'\"'") + "'";
    }

    public static final class ToolContentPeer {
        public static void main(String[] args) throws Exception {
            Files.writeString(Paths.get(args[1]), Long.toString(ProcessHandle.current().pid()));
            BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
            JSONObject request = JSON.parseObject(input.readLine());
            JSONObject initialized = JSON.parseObject("{\"type\":\"control_response\",\"response\":{\"subtype\":\"success\","
                    + "\"response\":{\"subtype\":\"initialize\",\"capabilities\":{}}}}");
            initialized.getJSONObject("response").put("request_id", request.get("request_id"));
            System.out.println(initialized);
            JSON.parseObject(input.readLine());

            JSONObject content = JSON.parseObject("{\"type\":\"tool_use\",\"id\":\"tool-fixture\",\"name\":\"list_files\","
                    + "\"input\":{\"path\":\"src/example.ts\",\"recursive\":false}}");
            if ("empty".equals(args[0])) {
                content.put("input", new JSONObject());
            } else if ("text".equals(args[0])) {
                content = JSON.parseObject("{\"type\":\"text\",\"text\":\"text control\"}");
            }
            JSONObject assistant = JSON.parseObject("{\"type\":\"assistant\",\"message\":{\"id\":\"assistant-fixture\"}}");
            assistant.getJSONObject("message").put("content", List.of(content));
            System.out.println(assistant);
            System.out.println("{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"done\"}");
            while (input.readLine() != null) {
                // Keep the process available until simpleQuery closes its transport.
            }
        }
    }
}
