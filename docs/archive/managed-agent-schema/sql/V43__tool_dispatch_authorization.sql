ALTER TABLE qwen_tool_execution
    ADD COLUMN authorized_dispatch_generation BIGINT;

ALTER TABLE qwen_tool_execution
    ADD COLUMN authorized_binding_version BIGINT;
