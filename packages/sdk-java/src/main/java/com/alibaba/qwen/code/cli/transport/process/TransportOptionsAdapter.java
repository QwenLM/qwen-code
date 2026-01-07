package com.alibaba.qwen.code.cli.transport.process;

import com.alibaba.qwen.code.cli.transport.TransportOptions;
import com.alibaba.qwen.code.cli.utils.Timeout;

import org.apache.commons.lang3.StringUtils;

import java.io.File;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.TimeUnit;

/**
 * Adapter that converts TransportOptions to command-line arguments for the CLI process.
 */
class TransportOptionsAdapter {
    /**
     * The adapted transport options.
     */
    TransportOptions transportOptions;
    /**
     * Default timeout for turns.
     */
    private static final Timeout DEFAULT_TURN_TIMEOUT = new Timeout(1000 * 60 * 30L, TimeUnit.MILLISECONDS);
    /**
     * Default timeout for messages.
     */
    private static final Timeout DEFAULT_MESSAGE_TIMEOUT = new Timeout(1000 * 60 * 3L, TimeUnit.MILLISECONDS);

    /**
     * Constructs a new adapter with the specified options.
     *
     * @param userTransportOptions The user's transport options
     */
    TransportOptionsAdapter(TransportOptions userTransportOptions) {
        transportOptions = addDefaultTransportOptions(userTransportOptions);
    }

    /**
     * Gets the processed transport options.
     *
     * @return The processed transport options
     */
    TransportOptions getHandledTransportOptions() {
        return transportOptions;
    }

    /**
     * Gets the current working directory.
     *
     * @return The current working directory
     */
    String getCwd() {
        return transportOptions.getCwd();
    }

    /**
     * Builds command-line arguments from the transport options.
     *
     * @return An array of command-line arguments
     */
    String[] buildCommandArgs() {
        List<String> args = new ArrayList<>(
                Arrays.asList(transportOptions.getPathToQwenExecutable(), "--input-format", "stream-json", "--output-format",
                        "stream-json", "--channel=SDK"));

        if (StringUtils.isNotBlank(transportOptions.getModel())) {
            args.add("--model");
            args.add(transportOptions.getModel());
        }

        if (transportOptions.getPermissionMode() != null) {
            args.add("--approval-mode");
            args.add(transportOptions.getPermissionMode().getValue());
        }

        if (transportOptions.getMaxSessionTurns() != null) {
            args.add("--max-session-turns");
            args.add(transportOptions.getMaxSessionTurns().toString());
        }

        if (transportOptions.getCoreTools() != null && !transportOptions.getCoreTools().isEmpty()) {
            args.add("--core-tools");
            args.add(String.join(",", transportOptions.getCoreTools()));
        }

        if (transportOptions.getExcludeTools() != null && !transportOptions.getExcludeTools().isEmpty()) {
            args.add("--exclude-tools");
            args.add(String.join(",", transportOptions.getExcludeTools()));
        }

        if (transportOptions.getAllowedTools() != null && !transportOptions.getAllowedTools().isEmpty()) {
            args.add("--allowed-tools");
            args.add(String.join(",", transportOptions.getAllowedTools()));
        }

        if (StringUtils.isNotBlank(transportOptions.getAuthType())) {
            args.add("--auth-type");
            args.add(transportOptions.getAuthType());
        }

        if (transportOptions.getIncludePartialMessages() != null && transportOptions.getIncludePartialMessages()) {
            args.add("--include-partial-messages");
        }

        if (transportOptions.getSkillsEnable() != null && transportOptions.getSkillsEnable()) {
            args.add("--experimental-skills");
        }

        if (StringUtils.isNotBlank(transportOptions.getResumeSessionId())) {
            args.add("--resume");
            args.add(transportOptions.getResumeSessionId());
        }

        if (transportOptions.getOtherOptions() != null) {
            args.addAll(transportOptions.getOtherOptions());
        }
        return args.toArray(new String[] {});
    }

    /**
     * Adds default values to the user's transport options.
     *
     * @param userTransportOptions The user's transport options
     * @return The options with defaults added
     */
    private TransportOptions addDefaultTransportOptions(TransportOptions userTransportOptions) {
        TransportOptions transportOptions = Optional.ofNullable(userTransportOptions)
                .map(TransportOptions::clone)
                .orElse(new TransportOptions());

        if (StringUtils.isBlank(transportOptions.getPathToQwenExecutable())) {
            transportOptions.setPathToQwenExecutable("qwen");
        }

        if (StringUtils.isBlank(transportOptions.getCwd())) {
            transportOptions.setCwd(new File("").getAbsolutePath());
        }

        Map<String, String> env = new HashMap<>(System.getenv());
        Optional.ofNullable(transportOptions.getEnv()).ifPresent(env::putAll);
        transportOptions.setEnv(env);

        if (transportOptions.getTurnTimeout() == null) {
            transportOptions.setTurnTimeout(DEFAULT_TURN_TIMEOUT);
        }

        if (transportOptions.getMessageTimeout() == null) {
            transportOptions.setMessageTimeout(DEFAULT_MESSAGE_TIMEOUT);
        }
        return transportOptions;
    }
}
