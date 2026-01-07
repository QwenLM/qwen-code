package com.alibaba.qwen.code.cli.example;

import com.alibaba.qwen.code.cli.QwenCodeCli;
import com.alibaba.qwen.code.cli.protocol.data.AssistantContent;
import com.alibaba.qwen.code.cli.protocol.data.AssistantContent.TextAssistantContent;
import com.alibaba.qwen.code.cli.protocol.data.AssistantContent.ThingkingAssistantContent;
import com.alibaba.qwen.code.cli.protocol.data.AssistantContent.ToolResultAssistantContent;
import com.alibaba.qwen.code.cli.protocol.data.AssistantContent.ToolUseAssistantContent;
import com.alibaba.qwen.code.cli.protocol.data.AssistantUsage;
import com.alibaba.qwen.code.cli.protocol.data.PermissionMode;
import com.alibaba.qwen.code.cli.protocol.data.behavior.Behavior.Operation;
import com.alibaba.qwen.code.cli.session.Session;
import com.alibaba.qwen.code.cli.session.event.consumers.AssistantContentSimpleConsumers;
import com.alibaba.qwen.code.cli.transport.TransportOptions;
import com.alibaba.qwen.code.cli.utils.Timeout;

import org.apache.commons.lang3.StringUtils;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.concurrent.TimeUnit;

public class QuickStartExample {
    private static final Logger logger = LoggerFactory.getLogger(QuickStartExample.class);

    public static void main(String[] args) {
        logger.info("runSimpleExample started.{}", StringUtils.repeat("=", 150));
        runSimpleExample();

        logger.info("runTransportOptionsExample started. {}", StringUtils.repeat("=", 150));
        runTransportOptionsExample();

        logger.info("runStreamingExample started. {}", StringUtils.repeat("=", 150));
        runStreamingExample();

        System.exit(0);
    }

    /**
     * Simple example showing basic query usage
     */
    public static void runSimpleExample() {
        List<String> result = QwenCodeCli.simpleQuery("hello world");
        result.forEach(logger::info);
    }

    /**
     * TransportOptions example showing comprehensive transport options configuration
     */
    public static void runTransportOptionsExample() {
            TransportOptions options = new TransportOptions()
                    .setModel("qwen3-coder-flash")
                    .setPermissionMode(PermissionMode.AUTO_EDIT)
                    .setCwd("./")
                    .setEnv(new HashMap<String, String>() {{put("CUSTOM_VAR", "value");}})
                    .setIncludePartialMessages(true)
                    .setTurnTimeout(new Timeout(120L, TimeUnit.SECONDS))
                    .setMessageTimeout(new Timeout(90L, TimeUnit.SECONDS))
                    .setAllowedTools(Arrays.asList("read_file", "write_file", "list_directory"));

        List<String> result = QwenCodeCli.simpleQuery("who are you, what are your capabilities?", options);
        result.forEach(logger::info);
    }

    /**
     * Streaming example showing simple query usage
     */
    public static void runStreamingExample() {
        QwenCodeCli.simpleQuery("who are you, what are your capabilities?",
                new TransportOptions().setMessageTimeout(new Timeout(10L, TimeUnit.SECONDS)), new AssistantContentSimpleConsumers() {

                    @Override
                    public void onText(Session session, TextAssistantContent textAssistantContent) {
                        logger.info("Text content received: {}", textAssistantContent.getText());
                    }

                    @Override
                    public void onThinking(Session session, ThingkingAssistantContent thingkingAssistantContent) {
                        logger.info("Thinking content received: {}", thingkingAssistantContent.getThinking());
                    }

                    @Override
                    public void onToolUse(Session session, ToolUseAssistantContent toolUseContent) {
                        logger.info("Tool use content received: {} with arguments: {}",
                                toolUseContent, toolUseContent.getInput());
                    }

                    @Override
                    public void onToolResult(Session session, ToolResultAssistantContent toolResultContent) {
                        logger.info("Tool result content received: {}", toolResultContent.getContent());
                    }

                    @Override
                    public void onOtherContent(Session session, AssistantContent<?> other) {
                        logger.info("Other content received: {}", other);
                    }

                    @Override
                    public void onUsage(Session session, AssistantUsage assistantUsage) {
                        logger.info("Usage information received: Input tokens: {}, Output tokens: {}",
                                assistantUsage.getUsage().getInputTokens(), assistantUsage.getUsage().getOutputTokens());
                    }
                }.setDefaultPermissionOperation(Operation.allow));
        logger.info("Streaming example completed.");
    }
}
