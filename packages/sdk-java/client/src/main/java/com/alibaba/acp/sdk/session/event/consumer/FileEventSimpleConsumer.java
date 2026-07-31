package com.alibaba.acp.sdk.session.event.consumer;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Optional;

import com.alibaba.acp.sdk.protocol.agent.request.ReadTextFileRequest;
import com.alibaba.acp.sdk.protocol.agent.request.ReadTextFileRequest.ReadTextFileRequestParams;
import com.alibaba.acp.sdk.protocol.agent.request.WriteTextFileRequest;
import com.alibaba.acp.sdk.protocol.client.response.ReadTextFileResponse.ReadTextFileResponseResult;
import com.alibaba.acp.sdk.protocol.client.response.WriteTextFileResponse.WriteTextFileResponseResult;
import com.alibaba.acp.sdk.session.event.consumer.exception.EventConsumeException;
import com.alibaba.acp.sdk.utils.Timeout;

import org.apache.commons.io.FileUtils;
import org.apache.commons.lang3.StringUtils;

import static com.alibaba.acp.sdk.protocol.jsonrpc.Error.ErrorCode.INTERNAL_ERROR;
import static com.alibaba.acp.sdk.protocol.jsonrpc.Error.ErrorCode.INVALID_PARAMS;
import static com.alibaba.acp.sdk.protocol.jsonrpc.Error.ErrorCode.RESOURCE_NOT_FOUND;

/**
 * Simple File Event Consumer Implementation
 *
 * This class provides a simple implementation of the FileEventConsumer interface
 * that handles file read and write operations. It supports reading text files with optional
 * line range parameters and writing content to text files.
 *
 * @author SkyFire
 * @version 0.0.1
 */
public class FileEventSimpleConsumer implements FileEventConsumer {
    @Override
    public ReadTextFileResponseResult onReadTextFileRequest(ReadTextFileRequest request) throws EventConsumeException {
        ReadTextFileResponseResult result = new ReadTextFileResponseResult();
        if (request == null) {
            return result;
        }
        String filePath = request.getParams().getPath();
        if (StringUtils.isBlank(filePath)) {
            return result;
        }
        File file = new File(filePath);
        if (!file.exists()) {
            throw new EventConsumeException().setError(RESOURCE_NOT_FOUND.getCode(), RESOURCE_NOT_FOUND.getDescription(), filePath);
        }
        int startLine = Optional.ofNullable(request.getParams())
                .map(ReadTextFileRequestParams::getLine)
                .orElse(1);
        int limit = Optional.ofNullable(request.getParams()).map(ReadTextFileRequestParams::getLimit).orElse(1000);
        try {
            StringBuilder content = new StringBuilder();
            try (BufferedReader br = new BufferedReader(new InputStreamReader(Files.newInputStream(file.toPath()), charset), 16384)) {
                for (int i = 1; i < startLine; i++) {
                    if (br.readLine() == null) {
                        return result;
                    }
                }
                String line;
                int count = 0;
                while (count < limit && (line = br.readLine()) != null) {
                    content.append(line).append(File.separator);
                    count++;
                }
            }
            result.setContent(content.toString());
            return result;
        } catch (IOException e) {
            throw new EventConsumeException("Failed to read file", e)
                    .setError(INTERNAL_ERROR.getCode(), INTERNAL_ERROR.getDescription(), filePath)
                    .addContextValue("filePath", filePath).addContextValue("startLine", startLine).addContextValue("limit", limit);
        }
    }

    @Override
    public WriteTextFileResponseResult onWriteTextFileRequest(WriteTextFileRequest request) throws EventConsumeException {
        if (request == null) {
            throw new EventConsumeException().setError(INVALID_PARAMS.getCode(), INVALID_PARAMS.getDescription(), "writeTextFileRequest can't be null");
        }
        String filePath = request.getParams().getPath();
        if (StringUtils.isBlank(filePath)) {
            throw new EventConsumeException().setError(INVALID_PARAMS.getCode(), INVALID_PARAMS.getDescription(), "the path of writeTextFileRequest can't be null");
        }
        File file = new File(filePath);
        String content = request.getParams().getContent();
        try {
            FileUtils.write(file, content, charset);
        } catch (IOException e) {
            throw new EventConsumeException("Failed to write file", e)
                    .setError(INTERNAL_ERROR.getCode(), INTERNAL_ERROR.getDescription(), filePath)
                    .addContextValue("filePath", filePath);
        }
        return new WriteTextFileResponseResult();
    }

    @Override
    public Timeout onReadTextFileRequestTimeout(ReadTextFileRequest message) {
        return readTimeout;
    }

    @Override
    public Timeout onWriteTextFileRequestTimeout(WriteTextFileRequest message) {
        return writeTimeout;
    }

    private Charset charset = StandardCharsets.UTF_8;
    private Timeout readTimeout = Timeout.TIMEOUT_3_SECONDS;
    private Timeout writeTimeout = Timeout.TIMEOUT_3_SECONDS;

    /**
     * Gets the character set used for file operations
     *
     * @return The character set used for file operations
     */
    public Charset getCharset() {
        return charset;
    }

    /**
     * Sets the character set used for file operations
     *
     * @param charset The character set to use for file operations
     */
    public void setCharset(Charset charset) {
        this.charset = charset;
    }

    /**
     * Gets the timeout for read file operations
     *
     * @return The timeout for read file operations
     */
    public Timeout getReadTimeout() {
        return readTimeout;
    }

    /**
     * Sets the timeout for read file operations
     *
     * @param readTimeout The timeout for read file operations
     */
    public void setReadTimeout(Timeout readTimeout) {
        this.readTimeout = readTimeout;
    }

    /**
     * Gets the timeout for write file operations
     *
     * @return The timeout for write file operations
     */
    public Timeout getWriteTimeout() {
        return writeTimeout;
    }

    /**
     * Sets the timeout for write file operations
     *
     * @param writeTimeout The timeout for write file operations
     */
    public void setWriteTimeout(Timeout writeTimeout) {
        this.writeTimeout = writeTimeout;
    }
}
