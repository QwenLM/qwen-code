package com.alibaba.qwen.code.cli.protocol.data;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.annotation.JSONField;

/**
 * Represents usage information for a message.
 *
 * @author skyfire
 * @version $Id: 0.0.1
 */
public class Usage {
    /**
     * Number of input tokens.
     */
    @JSONField(name = "input_tokens")
    private Integer inputTokens;
    /**
     * Number of output tokens.
     */
    @JSONField(name = "output_tokens")
    private Integer outputTokens;
    /**
     * Number of cache creation input tokens.
     */
    @JSONField(name = "cache_creation_input_tokens")
    private Integer cacheCreationInputTokens;
    /**
     * Number of cache read input tokens.
     */
    @JSONField(name = "cache_read_input_tokens")
    private Integer cacheReadInputTokens;
    /**
     * Total number of tokens.
     */
    @JSONField(name = "total_tokens")
    private Integer totalTokens;

    /**
     * Gets the number of input tokens.
     *
     * @return The number of input tokens
     */
    public Integer getInputTokens() {
        return inputTokens;
    }

    /**
     * Sets the number of input tokens.
     *
     * @param inputTokens The number of input tokens
     */
    public void setInputTokens(Integer inputTokens) {
        this.inputTokens = inputTokens;
    }

    /**
     * Gets the number of output tokens.
     *
     * @return The number of output tokens
     */
    public Integer getOutputTokens() {
        return outputTokens;
    }

    /**
     * Sets the number of output tokens.
     *
     * @param outputTokens The number of output tokens
     */
    public void setOutputTokens(Integer outputTokens) {
        this.outputTokens = outputTokens;
    }

    /**
     * Gets the number of cache creation input tokens.
     *
     * @return The number of cache creation input tokens
     */
    public Integer getCacheCreationInputTokens() {
        return cacheCreationInputTokens;
    }

    /**
     * Sets the number of cache creation input tokens.
     *
     * @param cacheCreationInputTokens The number of cache creation input tokens
     */
    public void setCacheCreationInputTokens(Integer cacheCreationInputTokens) {
        this.cacheCreationInputTokens = cacheCreationInputTokens;
    }

    /**
     * Gets the number of cache read input tokens.
     *
     * @return The number of cache read input tokens
     */
    public Integer getCacheReadInputTokens() {
        return cacheReadInputTokens;
    }

    /**
     * Sets the number of cache read input tokens.
     *
     * @param cacheReadInputTokens The number of cache read input tokens
     */
    public void setCacheReadInputTokens(Integer cacheReadInputTokens) {
        this.cacheReadInputTokens = cacheReadInputTokens;
    }

    /**
     * Gets the total number of tokens.
     *
     * @return The total number of tokens
     */
    public Integer getTotalTokens() {
        return totalTokens;
    }

    /**
     * Sets the total number of tokens.
     *
     * @param totalTokens The total number of tokens
     */
    public void setTotalTokens(Integer totalTokens) {
        this.totalTokens = totalTokens;
    }

    /**
     * <p>toString.</p>
     *
     * @return a {@link java.lang.String} object.
     */
    public String toString() {
        return JSON.toJSONString(this);
    }
}
