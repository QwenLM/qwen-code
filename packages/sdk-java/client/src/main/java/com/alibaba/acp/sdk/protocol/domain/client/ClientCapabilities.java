package com.alibaba.acp.sdk.protocol.domain.client;

import com.alibaba.acp.sdk.protocol.jsonrpc.Meta;

/**
 * Client Capabilities Class
 *
 * Describes functional capabilities supported by the client, such as file system operations and terminal functionality.
 */
public class ClientCapabilities extends Meta {
    private FileSystemCapability fs = new FileSystemCapability();
    private boolean terminal;

    /**
     * Gets the file system capability
     *
     * @return File system capability object
     */
    public FileSystemCapability getFs() {
        return fs;
    }

    /**
     * Sets the file system capability
     *
     * @param fs File system capability object
     * @return Current object instance, facilitating method chaining
     */
    public ClientCapabilities setFs(FileSystemCapability fs) {
        this.fs = fs;
        return this;
    }

    /**
     * Checks if terminal functionality is supported
     *
     * @return True if terminal functionality is supported, false otherwise
     */
    public boolean getTerminal() {
        return terminal;
    }

    /**
     * Sets terminal functionality support
     *
     * @param terminal Whether terminal functionality is supported
     * @return Current object instance, facilitating method chaining
     */
    public ClientCapabilities setTerminal(Boolean terminal) {
        this.terminal = terminal;
        return this;
    }

    /**
     * File System Capability Class
     *
     * Describes the client's support capabilities for file system operations, such as reading and writing text files.
     */
    public static class FileSystemCapability extends Meta {
        private boolean readTextFile;
        private boolean writeTextFile;

        /**
         * Default constructor
         */
        public FileSystemCapability() {
        }

        /**
         * Constructs a file system capability object with specified parameters
         *
         * @param readTextFile Whether reading text files is supported
         * @param writeTextFile Whether writing text files is supported
         */
        public FileSystemCapability(boolean readTextFile, boolean writeTextFile) {
            this.readTextFile = readTextFile;
            this.writeTextFile = writeTextFile;
        }

        /**
         * Checks if reading text files is supported
         *
         * @return True if reading text files is supported, false otherwise
         */
        public boolean getReadTextFile() {
            return readTextFile;
        }

        /**
         * Sets reading text files support
         *
         * @param readTextFile Whether reading text files is supported
         * @return Current object instance, facilitating method chaining
         */
        public FileSystemCapability setReadTextFile(boolean readTextFile) {
            this.readTextFile = readTextFile;
            return this;
        }

        /**
         * Checks if writing text files is supported
         *
         * @return True if writing text files is supported, false otherwise
         */
        public boolean getWriteTextFile() {
            return writeTextFile;
        }

        /**
         * Sets writing text files support
         *
         * @param writeTextFile Whether writing text files is supported
         * @return Current object instance, facilitating method chaining
         */
        public FileSystemCapability setWriteTextFile(boolean writeTextFile) {
            this.writeTextFile = writeTextFile;
            return this;
        }
    }
}
