package com.alibaba.acp.sdk.session.event.consumer;

/**
 * Agent Event Consumer Container
 *
 * This class serves as a container for various event consumers that handle different types of events
 * received from the AI agent during a session, such as content updates, file operations, terminal commands, etc.
 *
 * @author SkyFire
 * @version 0.0.1
 */
public class AgentEventConsumer {
    private ContentEventConsumer contentEventConsumer;
    private FileEventConsumer fileEventConsumer;
    private TerminalEventConsumer terminalEventConsumer;
    private PermissionEventConsumer permissionEventConsumer;
    private PromptEndEventConsumer promptEndEventConsumer;

    /**
     * Gets the content event consumer
     *
     * @return ContentEventConsumer instance for handling content-related events
     */
    public ContentEventConsumer getContentEventConsumer() {
        return contentEventConsumer;
    }

    /**
     * Sets the content event consumer
     *
     * @param contentEventConsumer ContentEventConsumer instance for handling content-related events
     * @return Current instance for method chaining
     */
    public AgentEventConsumer setContentEventConsumer(ContentEventConsumer contentEventConsumer) {
        this.contentEventConsumer = contentEventConsumer;
        return this;
    }

    /**
     * Gets the file event consumer
     *
     * @return FileEventConsumer instance for handling file-related events
     */
    public FileEventConsumer getFileEventConsumer() {
        return fileEventConsumer;
    }

    /**
     * Sets the file event consumer
     *
     * @param fileEventConsumer FileEventConsumer instance for handling file-related events
     * @return Current instance for method chaining
     */
    public AgentEventConsumer setFileEventConsumer(FileEventConsumer fileEventConsumer) {
        this.fileEventConsumer = fileEventConsumer;
        return this;
    }

    /**
     * Gets the terminal event consumer
     *
     * @return TerminalEventConsumer instance for handling terminal-related events
     */
    public TerminalEventConsumer getTerminalEventConsumer() {
        return terminalEventConsumer;
    }

    /**
     * Sets the terminal event consumer
     *
     * @param terminalEventConsumer TerminalEventConsumer instance for handling terminal-related events
     * @return Current instance for method chaining
     */
    public AgentEventConsumer setTerminalEventConsumer(TerminalEventConsumer terminalEventConsumer) {
        this.terminalEventConsumer = terminalEventConsumer;
        return this;
    }

    /**
     * Gets the permission event consumer
     *
     * @return PermissionEventConsumer instance for handling permission-related events
     */
    public PermissionEventConsumer getPermissionEventConsumer() {
        return permissionEventConsumer;
    }

    /**
     * Sets the permission event consumer
     *
     * @param permissionEventConsumer PermissionEventConsumer instance for handling permission-related events
     * @return Current instance for method chaining
     */
    public AgentEventConsumer setPermissionEventConsumer(PermissionEventConsumer permissionEventConsumer) {
        this.permissionEventConsumer = permissionEventConsumer;
        return this;
    }

    /**
     * Gets the prompt end event consumer
     *
     * @return PromptEndEventConsumer instance for handling prompt completion events
     */
    public PromptEndEventConsumer getPromptEndEventConsumer() {
        return promptEndEventConsumer;
    }

    /**
     * Sets the prompt end event consumer
     *
     * @param promptEndEventConsumer PromptEndEventConsumer instance for handling prompt completion events
     * @return Current instance for method chaining
     */
    public AgentEventConsumer setPromptEndEventConsumer(PromptEndEventConsumer promptEndEventConsumer) {
        this.promptEndEventConsumer = promptEndEventConsumer;
        return this;
    }
}
