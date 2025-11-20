#!/bin/bash

# Log the timeout test
echo "Timeout hook started: $(date)" >> /tmp/qwen_hook_test.log

# Sleep for longer than typical timeout to test timeout handling
sleep 10

# This should never be reached in a timeout test
echo '{"hookSpecificOutput": {"hookEventName": "timeout_test", "additionalContext": "This should not be reached"}}'
exit 0