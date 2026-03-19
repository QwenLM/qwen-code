package com.alibaba.acp.sdk.utils;

import java.io.IOException;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeoutException;

import com.alibaba.acp.sdk.protocol.jsonrpc.Message;
import com.alibaba.acp.sdk.transport.Transport;
import com.alibaba.fastjson2.JSON;

/**
 * Transport Utilities Class
 *
 * Provides common utility methods related to the transport layer, such as sending messages and waiting for single-line responses.
 *
 * @author SkyFire
 * @version 0.0.1
 */
public class TransportUtils {
    /**
     * Sends a message and waits for a single-line response through the transport layer
     *
     * Sends the message to the transport layer, waits and receives a single-line response, then parses it into an object of the specified type.
     *
     * @param transport Transport instance for sending and receiving messages
     * @param message Message object to send
     * @param responseClass Target type for the response message
     * @param <C> Type of the response object
     * @return Parsed response object
     * @throws IOException Thrown when IO operations fail
     * @throws ExecutionException Thrown when an error occurs during execution
     * @throws InterruptedException Thrown when the operation is interrupted
     * @throws TimeoutException Thrown when the operation times out
     */
    public static <C> C inputWaitForOneLine(Transport transport, Message message, Class<C> responseClass) throws IOException, ExecutionException, InterruptedException, TimeoutException {
        return JSON.parseObject(transport.inputWaitForOneLine(message.toString()), responseClass);
    }
}
