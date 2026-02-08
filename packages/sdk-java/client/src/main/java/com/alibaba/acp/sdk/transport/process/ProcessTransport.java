package com.alibaba.acp.sdk.transport.process;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.lang.ProcessBuilder.Redirect;
import java.util.Optional;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Future;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import java.util.function.Function;

import org.apache.commons.lang3.Validate;
import org.apache.commons.lang3.exception.ContextedRuntimeException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.alibaba.acp.sdk.transport.Transport;
import com.alibaba.acp.sdk.utils.MyConcurrentUtils;
import com.alibaba.acp.sdk.utils.Timeout;

/**
 * Implementation of the Transport interface that communicates with the ACP agent via a process.
 * This class manages a subprocess that communicates with an ACP-compatible agent,
 * handling message exchange, process lifecycle, and error handling.
 *
 * @author SkyFire
 * @version 0.0.1
 */
public class ProcessTransport implements Transport {
    private static final Logger log = LoggerFactory.getLogger(ProcessTransport.class);

    private final String cwd;
    private final String[] commandArgs;

    protected Timeout turnTimeout;
    protected Timeout messageTimeout;

    protected volatile Process process;
    protected BufferedWriter processInput;
    protected BufferedReader processOutput;
    protected BufferedReader processError;
    protected Future<Void> processErrorFuture;
    protected final Consumer<String> errorHandler;

    private final AtomicBoolean reading = new AtomicBoolean(false);

    /**
     * Constructs a new ProcessTransport with the specified options.
     *
     * @param transportOptions The transport options to configure the process transport
     */
    public ProcessTransport(ProcessTransportOptions transportOptions) {
        Validate.notNull(transportOptions, "transportOptions can not be null");

        Validate.notEmpty(transportOptions.getCommandArgs(), "commandArgs of transportOptions can't be empty");
        this.commandArgs = transportOptions.getCommandArgs();

        this.cwd = Optional.ofNullable(transportOptions.getCwd()).orElse("./");
        this.turnTimeout = Optional.ofNullable(transportOptions.getTurnTimeout()).orElse(Timeout.TIMEOUT_30_MINUTES);
        this.messageTimeout = Optional.ofNullable(transportOptions.getMessageTimeout()).orElse(Timeout.TIMEOUT_180_SECONDS);
        this.errorHandler = Optional.ofNullable(transportOptions.getErrorHandler()).orElse((line) -> log.error("process error: {}", line));
    }

    /**
     * {@inheritDoc}
     */
    @Override
    public boolean isReading() {
        return reading.get();
    }

    /**
     * {@inheritDoc}
     */
    @Override
    public void start() throws IOException {
        if (process != null) {
            return;
        }
        ProcessBuilder processBuilder = new ProcessBuilder(commandArgs)
                .redirectOutput(Redirect.PIPE)
                .redirectInput(Redirect.PIPE)
                .redirectError(Redirect.PIPE)
                .redirectErrorStream(false)
                .directory(new File(cwd));

        process = processBuilder.start();
        processInput = new BufferedWriter(new OutputStreamWriter(process.getOutputStream()));
        processOutput = new BufferedReader(new InputStreamReader(process.getInputStream()));
        processError = new BufferedReader(new InputStreamReader(process.getErrorStream()));
        startErrorReading();
    }

    /**
     * {@inheritDoc}
     */
    @Override
    public void close() throws IOException {
        if (process != null) {
            process.getErrorStream().close();
            process.getOutputStream().close();
            process.getInputStream().close();
            process.destroy();
        }
        if (processInput != null) {
            processInput.close();
        }
        if (processOutput != null) {
            processOutput.close();
        }
        if (processError != null) {
            processError.close();
        }
    }

    /**
     * {@inheritDoc}
     */
    @Override
    public boolean isAvailable() {
        return process != null && process.isAlive();
    }

    /**
     * {@inheritDoc}
     */
    @Override
    public String inputWaitForOneLine(String message) throws IOException, ExecutionException, InterruptedException, TimeoutException {
        return inputWaitForOneLine(message, turnTimeout);
    }

    private String inputWaitForOneLine(String message, Timeout timeOut)
            throws IOException, TimeoutException, InterruptedException, ExecutionException {
        inputNoWaitResponse(message);
        try {
            reading.set(true);
            String line = MyConcurrentUtils.runAndWait(() -> {
                try {
                    return processOutput.readLine();
                } catch (IOException e) {
                    throw new ContextedRuntimeException("read line error", e)
                            .addContextValue("message", message);
                }
            }, timeOut);
            log.trace("inputWaitForOneLine result: {}", line);
            return line;
        } finally {
            reading.set(false);
        }
    }

    /**
     * {@inheritDoc}
     */
    @Override
    public void inputWaitForMultiLine(String message, Function<String, Boolean> callBackFunction) throws IOException {
        inputWaitForMultiLine(message, callBackFunction, turnTimeout);
    }

    private void inputWaitForMultiLine(String message, Function<String, Boolean> callBackFunction, Timeout timeOut) throws IOException {
        log.trace("input message for multiLine: {}", message);
        inputNoWaitResponse(message);
        MyConcurrentUtils.runAndWait(() -> iterateOutput(callBackFunction), timeOut);
    }

    /**
     * {@inheritDoc}
     */
    @Override
    public void inputNoWaitResponse(String message) throws IOException {
        log.trace("input message to process: {}", message);
        processInput.write(message);
        processInput.newLine();
        processInput.flush();
    }

    private void startErrorReading() {
        processErrorFuture = MyConcurrentUtils.asyncRun(() -> {
            try {
                for (; ; ) {
                    final String line = processError.readLine();
                    if (line == null) {
                        break;
                    }
                    if (errorHandler != null) {
                        try {
                            MyConcurrentUtils.runAndWait(() -> errorHandler.accept(line), messageTimeout);
                        } catch (Exception e) {
                            log.warn("error handler error", e);
                        }
                    }
                }
            } catch (IOException e) {
                log.warn("Failed read error {}, caused by {}", e.getMessage(), e.getCause(), e);
            }
        }, (e, t) -> log.warn("read error {}", t.getMessage(), t));
    }

    private void iterateOutput(Function<String, Boolean> callBackFunction) {
        try {
            reading.set(true);
            MyConcurrentUtils.runAndWait(() -> {
                try {
                    for (; ; ) {
                        String line = processOutput.readLine();
                        if (line == null) {
                            break;
                        }
                        log.trace("read a message from process {}", line);
                        if (callBackFunction.apply(line)) {
                            break;
                        }
                    }
                } catch (IOException e) {
                    throw new RuntimeException("read process output error", e);
                }
            }, messageTimeout);
        } finally {
            reading.set(false);
        }
    }
}
