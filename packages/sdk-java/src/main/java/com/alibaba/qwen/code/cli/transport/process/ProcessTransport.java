package com.alibaba.qwen.code.cli.transport.process;

import com.alibaba.qwen.code.cli.transport.Transport;
import com.alibaba.qwen.code.cli.transport.TransportOptions;
import com.alibaba.qwen.code.cli.utils.MyConcurrentUtils;
import com.alibaba.qwen.code.cli.utils.Timeout;

import org.apache.commons.lang3.exception.ContextedRuntimeException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.lang.ProcessBuilder.Redirect;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import java.util.function.Function;

/**
 * Implementation of the Transport interface that communicates with the Qwen CLI via a process.
 *
 * @author skyfire
 * @version $Id: 0.0.1
 */
public class ProcessTransport implements Transport {
    private static final Logger log = LoggerFactory.getLogger(ProcessTransport.class);
    private final TransportOptions transportOptions;
    protected Timeout turnTimeout;
    protected Timeout messageTimeout;

    protected Process process;
    protected BufferedWriter processInput;
    protected BufferedReader processOutput;
    protected BufferedReader processError;
    protected final Consumer<String> errorHandler;

    private final AtomicBoolean reading = new AtomicBoolean(false);

    /**
     * Constructs a new ProcessTransport with default options.
     *
     * @throws java.io.IOException if starting the process fails
     */
    public ProcessTransport() throws IOException {
        this(new TransportOptions());
    }

    /**
     * Constructs a new ProcessTransport with the specified options.
     *
     * @param transportOptions The transport options to use
     * @throws java.io.IOException if starting the process fails
     */
    public ProcessTransport(TransportOptions transportOptions) throws IOException {
        this(transportOptions, (line) -> log.error("process error: {}", line));
    }

    /**
     * Constructs a new ProcessTransport with the specified options and error handler.
     *
     * @param transportOptions The transport options to use
     * @param errorHandler The error handler to use
     * @throws java.io.IOException if starting the process fails
     */
    public ProcessTransport(TransportOptions transportOptions, Consumer<String> errorHandler) throws IOException {
        this.transportOptions = transportOptions;
        this.errorHandler = errorHandler;
        start();
    }

    /** {@inheritDoc} */
    @Override
    public TransportOptions getTransportOptions() {
        return transportOptions;
    }

    /** {@inheritDoc} */
    @Override
    public boolean isReading() {
        return reading.get();
    }

    /** {@inheritDoc} */
    @Override
    public void start() throws IOException {
        TransportOptionsAdapter transportOptionsAdapter = new TransportOptionsAdapter(transportOptions);
        this.turnTimeout = transportOptionsAdapter.getHandledTransportOptions().getTurnTimeout();
        this.messageTimeout = transportOptionsAdapter.getHandledTransportOptions().getMessageTimeout();

        String[] commandArgs = transportOptionsAdapter.buildCommandArgs();
        log.debug("trans to command args: {}", transportOptionsAdapter);

        ProcessBuilder processBuilder = new ProcessBuilder(commandArgs)
                .redirectOutput(Redirect.PIPE)
                .redirectInput(Redirect.PIPE)
                .redirectError(Redirect.PIPE)
                .redirectErrorStream(false)
                .directory(new File(transportOptionsAdapter.getCwd()));

        process = processBuilder.start();
        processInput = new BufferedWriter(new OutputStreamWriter(process.getOutputStream()));
        processOutput = new BufferedReader(new InputStreamReader(process.getInputStream()));
        processError = new BufferedReader(new InputStreamReader(process.getErrorStream()));
        startErrorReading();
    }

    /** {@inheritDoc} */
    @Override
    public void close() throws IOException {
        if (processInput != null) {
            processInput.close();
        }
        if (processOutput != null) {
            processOutput.close();
        }
        if (processError != null) {
            processError.close();
        }
        if (process != null) {
            process.destroy();
        }
    }

    /** {@inheritDoc} */
    @Override
    public boolean isAvailable() {
        return process != null && process.isAlive();
    }

    /** {@inheritDoc} */
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
            log.info("inputWaitForOneLine result: {}", line);
            return line;
        } finally {
            reading.set(false);
        }
    }

    /** {@inheritDoc} */
    @Override
    public void inputWaitForMultiLine(String message, Function<String, Boolean> callBackFunction) throws IOException {
        inputWaitForMultiLine(message, callBackFunction, turnTimeout);
    }

    private void inputWaitForMultiLine(String message, Function<String, Boolean> callBackFunction, Timeout timeOut) throws IOException {
        log.debug("input message for multiLine: {}", message);
        inputNoWaitResponse(message);
        MyConcurrentUtils.runAndWait(() -> iterateOutput(callBackFunction), timeOut);
    }

    /** {@inheritDoc} */
    @Override
    public void inputNoWaitResponse(String message) throws IOException {
        log.debug("input message to process: {}", message);
        processInput.write(message);
        processInput.newLine();
        processInput.flush();
    }

    private void startErrorReading() {
        MyConcurrentUtils.asyncRun(() -> {
            try {
                for (;;) {
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
                    for (String line = processOutput.readLine(); line != null; line = processOutput.readLine()) {
                        log.debug("read a message from process {}", line);
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
