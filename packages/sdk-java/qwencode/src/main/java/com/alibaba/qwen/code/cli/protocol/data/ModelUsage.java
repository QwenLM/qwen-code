package com.alibaba.qwen.code.cli.protocol.data;

/**
 * Represents usage information for a specific model.
 *
 * @author skyfire
 * @version $Id: 0.0.1
 */
public class ModelUsage {
    /**
     * Number of input tokens.
     */
    private int inputTokens;
    /**
     * Number of output tokens.
     */
    private int outputTokens;
    /**
     * Number of cache read input tokens.
     */
    private int cacheReadInputTokens;
    /**
     * Number of cache creation input tokens.
     */
    private int cacheCreationInputTokens;
    /**
     * Number of web search requests.
     */
    private int webSearchRequests;
    /**
     * Context window size.
     */
    private int contextWindow;

    /**
     * Gets the number of input tokens.
     *
     * @return The number of input tokens
     */
    public int getInputTokens() {
        return inputTokens;
    }

    /**
     * Sets the number of input tokens.
     *
     * @param inputTokens The number of input tokens
     */
    public void setInputTokens(int inputTokens) {
        this.inputTokens = inputTokens;
    }

    /**
     * Gets the number of output tokens.
     *
     * @return The number of output tokens
     */
    public int getOutputTokens() {
        return outputTokens;
    }

    /**
     * Sets the number of output tokens.
     *
     * @param outputTokens The number of output tokens
     */
    public void setOutputTokens(int outputTokens) {
        this.outputTokens = outputTokens;
    }

    /**
     * Gets the number of cache read input tokens.
     *
     * @return The number of cache read input tokens
     */
    public int getCacheReadInputTokens() {
        return cacheReadInputTokens;
    }

    /**
     * Sets the number of cache read input tokens.
     *
     * @param cacheReadInputTokens The number of cache read input tokens
     */
    public void setCacheReadInputTokens(int cacheReadInputTokens) {
        this.cacheReadInputTokens = cacheReadInputTokens;
    }

    /**
     * Gets the number of cache creation input tokens.
     *
     * @return The number of cache creation input tokens
     */
    public int getCacheCreationInputTokens() {
        return cacheCreationInputTokens;
    }

    /**
     * Sets the number of cache creation input tokens.
     *
     * @param cacheCreationInputTokens The number of cache creation input tokens
     */
    public void setCacheCreationInputTokens(int cacheCreationInputTokens) {
        this.cacheCreationInputTokens = cacheCreationInputTokens;
    }

    /**
     * Gets the number of web search requests.
     *
     * @return The number of web search requests
     */
    public int getWebSearchRequests() {
        return webSearchRequests;
    }

    /**
     * Sets the number of web search requests.
     *
     * @param webSearchRequests The number of web search requests
     */
    public void setWebSearchRequests(int webSearchRequests) {
        this.webSearchRequests = webSearchRequests;
    }

    /**
     * Gets the context window size.
     *
     * @return The context window size
     */
    public int getContextWindow() {
        return contextWindow;
    }

    /**
     * Sets the context window size.
     *
     * @param contextWindow The context window size
     */
    public void setContextWindow(int contextWindow) {
        this.contextWindow = contextWindow;
    }
}
