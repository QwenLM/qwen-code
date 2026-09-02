package com.alibaba.qwen.code.daemon;

/** This session client already owns an unfinished local prompt call. */
public final class PromptAlreadyActiveException extends DaemonException {
    PromptAlreadyActiveException() {
        super("DaemonSessionClient permits only one local prompt at a time");
    }
}
