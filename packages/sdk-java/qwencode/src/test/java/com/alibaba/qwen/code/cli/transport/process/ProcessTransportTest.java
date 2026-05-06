package com.alibaba.qwen.code.cli.transport.process;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Collections;
import java.util.UUID;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeoutException;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.TypeReference;
import com.alibaba.qwen.code.cli.protocol.message.control.payload.CLIControlInitializeRequest;
import com.alibaba.qwen.code.cli.protocol.message.control.payload.CLIControlInitializeResponse;
import com.alibaba.qwen.code.cli.protocol.message.control.CLIControlRequest;
import com.alibaba.qwen.code.cli.protocol.message.control.CLIControlResponse;
import com.alibaba.qwen.code.cli.protocol.message.SDKUserMessage;
import com.alibaba.qwen.code.cli.transport.Transport;
import com.alibaba.qwen.code.cli.transport.TransportOptions;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import static org.junit.jupiter.api.Assertions.assertEquals;

class ProcessTransportTest {

    private static final Logger logger = LoggerFactory.getLogger(ProcessTransportTest.class);
    private static final String CUSTOM_ENV_NAME = "QWEN_SDK_TEST_ENV";
    private static final String CUSTOM_ENV_VALUE = "from-set-env";

    @TempDir
    Path tempDir;

    @Test
    void shouldStartAndCloseSuccessfully() throws IOException {
        TransportOptions transportOptions = new TransportOptions();
        Transport transport = new ProcessTransport(transportOptions);
        transport.close();
    }

    @Test
    void shouldPassCustomEnvToProcess() throws IOException {
        Path executable = createEnvPrinter();
        TransportOptions transportOptions = new TransportOptions()
                .setPathToQwenExecutable(executable.toString())
                .setEnv(Collections.singletonMap(CUSTOM_ENV_NAME, CUSTOM_ENV_VALUE));

        ProcessTransport transport = new ProcessTransport(transportOptions);
        try {
            assertEquals(CUSTOM_ENV_VALUE, transport.processOutput.readLine());
        } finally {
            transport.close();
        }
    }

    @Test
    void shouldInputWaitForOneLineSuccessfully() throws IOException, ExecutionException, InterruptedException, TimeoutException {
        TransportOptions transportOptions = new TransportOptions();
        Transport transport = new ProcessTransport(transportOptions);

        String message = "{\"type\": \"control_request\", \"request_id\": \"1\", \"request\": {\"subtype\": \"initialize\"} }";
        System.out.println(transport.inputWaitForOneLine(message));
    }

    @Test
    void shouldInitializeSuccessfully() throws IOException, ExecutionException, InterruptedException, TimeoutException {
        Transport transport = new ProcessTransport();

        String message = CLIControlRequest.create(new CLIControlInitializeRequest()).toString();
        String responseMsg = transport.inputWaitForOneLine(message);
        logger.info("responseMsg: {}", responseMsg);
        CLIControlResponse<CLIControlInitializeResponse> response = JSON.parseObject(responseMsg,
                new TypeReference<CLIControlResponse<CLIControlInitializeResponse>>() {});
        logger.info("response: {}", response);
    }

    @Test
    void shouldSdkMessageSuccessfully() throws IOException, ExecutionException, InterruptedException, TimeoutException {
        Transport transport = new ProcessTransport();
        String message = CLIControlRequest.create(new CLIControlInitializeRequest()).toString();
        transport.inputWaitForOneLine(message);

        String sessionId = "session-" + UUID.randomUUID().toString();
        String userMessage = new SDKUserMessage().setSessionId(sessionId).setContent("hello world").toString();
        transport.inputWaitForMultiLine(userMessage, line -> {
            return "result".equals(JSON.parseObject(line).getString("type"));
        });

        String userMessage2 = new SDKUserMessage().setSessionId(sessionId).setContent("Please respond in Chinese").toString();
        transport.inputWaitForMultiLine(userMessage2, line -> {
            return "result".equals(JSON.parseObject(line).getString("type"));
        });


        String userMessage3 = new SDKUserMessage().setSessionId(sessionId).setContent("How many files are there in the current workspace").toString();
        transport.inputWaitForMultiLine(userMessage3, line -> {
            return "result".equals(JSON.parseObject(line).getString("type"));
        });

        String userMessage4 = new SDKUserMessage().setSessionId("session-sec" + UUID.randomUUID()).setContent("How many XML files are there").toString();
        transport.inputWaitForMultiLine(userMessage4, line -> {
            return "result".equals(JSON.parseObject(line).getString("type"));
        });

        transport.inputWaitForOneLine(CLIControlRequest.create(new CLIControlInitializeRequest()).toString());
        transport.inputWaitForMultiLine(new SDKUserMessage().setContent("您好").toString(),
                line -> "result".equals(JSON.parseObject(line).getString("type")));
    }

    private Path createEnvPrinter() throws IOException {
        boolean isWindows = System.getProperty("os.name").toLowerCase().contains("win");
        Path executable = tempDir.resolve(isWindows ? "print-env.cmd" : "print-env.sh");
        String script = isWindows
                ? "@echo off\r\necho %" + CUSTOM_ENV_NAME + "%\r\n"
                : "#!/bin/sh\nprintf '%s\\n' \"$" + CUSTOM_ENV_NAME + "\"\n";
        Files.write(executable, script.getBytes(StandardCharsets.UTF_8));
        executable.toFile().setExecutable(true);
        return executable;
    }

}
