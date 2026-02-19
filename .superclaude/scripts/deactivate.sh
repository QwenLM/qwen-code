#!/bin/bash
# Deactivate SuperClaude Framework

# Deactivate virtual environment if active
if [ -n "$VIRTUAL_ENV" ]; then
    deactivate 2>/dev/null || true
fi

# Unset SuperClaude variables
unset SUPERCLAUDE_HOME

echo "❌ SuperClaude Framework deactivated"
echo "   Back to system Python environment"
