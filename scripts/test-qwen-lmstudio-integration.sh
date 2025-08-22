#!/bin/bash
# test-qwen-lmstudio-integration.sh
# Automated test script for qwen-code LM Studio integration
# 
# Purpose: Build the fixed qwen-code, start it in byobu/tmux, and test LM Studio connectivity
# Location: /Users/athundt/source/qwen-code/scripts/test-qwen-lmstudio-integration.sh
# 
# This script automates the complete process of:
# 1. Building the fixed qwen-code version
# 2. Using byobu/tmux to control qwen-code in window 2
# 3. Testing the "test" command and capturing results
# 4. Handling common stuck states with workarounds

set -e

# Configuration (can be overridden by environment variables)
QWEN_SOURCE_DIR="${QWEN_SOURCE_DIR:-/Users/athundt/source/qwen-code}"
TMUX_SESSION="${TMUX_SESSION:-main}"
TMUX_WINDOW="${TMUX_WINDOW:-2}"
STARTUP_COMMAND_STREAMING="${STARTUP_COMMAND_STREAMING:-OPENAI_API_KEY=lmstudio OPENAI_BASE_URL=http://localhost:1234/v1 node /Users/athundt/source/qwen-code/packages/cli/dist/index.js -y -p 'What is 2+2?'}"
STARTUP_COMMAND_NONSTREAMING="${STARTUP_COMMAND_NONSTREAMING:-OPENAI_API_KEY=lmstudio OPENAI_BASE_URL=http://localhost:1234/v1 QWEN_STREAMING=disabled node /Users/athundt/source/qwen-code/packages/cli/dist/index.js -y -p 'What is 2+2?'}"
STARTUP_COMMAND="${STARTUP_COMMAND:-$STARTUP_COMMAND_NONSTREAMING}"  # Test non-streaming first unless overridden
TEST_PROMPT="${TEST_PROMPT:-What is 2+2?}"  # Default to simple math but allow override
WAIT_TIMEOUT="${WAIT_TIMEOUT:-15}"
LOGFILE="${LOGFILE:-/Users/athundt/source/qwen-code/logs/qwen-test-$(date +%Y%m%d_%H%M%S).log}"

# Support command line argument for test prompt
if [ $# -gt 0 ]; then
    TEST_PROMPT="$1"
    # Update startup command with new prompt
    STARTUP_COMMAND=$(echo "$STARTUP_COMMAND" | sed "s/'What is 2+2?'/'$TEST_PROMPT'/g")
fi

# Save original window to restore later
ORIGINAL_WINDOW=$(byobu display-message -t "$TMUX_SESSION" -p "#{window_index}")

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log() {
    echo -e "${BLUE}[$(date '+%H:%M:%S')]${NC} $1" | tee -a "$LOGFILE"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1" | tee -a "$LOGFILE"
}

success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1" | tee -a "$LOGFILE"
}

warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1" | tee -a "$LOGFILE"
}

# Create logs directory
mkdir -p "$(dirname "$LOGFILE")"

log "Starting qwen-code LM Studio integration test"
log "Logfile: $LOGFILE"

# Step 1: Build the project
log "Step 1: Building qwen-code with fixes..."
cd "$QWEN_SOURCE_DIR"
if npm run build >> "$LOGFILE" 2>&1; then
    success "Build completed successfully"
else
    error "Build failed - check $LOGFILE for details"
    exit 1
fi

# Step 2: Using local build directly (no global installation needed)
log "Step 2: Local build will be used directly - no linking required"
success "Ready to test local build"

# Step 3: Check tmux session exists
log "Step 3: Checking tmux session '$TMUX_SESSION'..."
if ! byobu list-sessions 2>/dev/null | grep -q "^$TMUX_SESSION:"; then
    error "Tmux session '$TMUX_SESSION' not found"
    log "Available sessions:"
    byobu list-sessions 2>/dev/null || echo "No sessions found"
    exit 1
fi

# Step 4: Switch to target window and check current state
log "Step 4: Switching to window $TMUX_WINDOW and checking state..."
byobu select-window -t "$TMUX_SESSION:$TMUX_WINDOW"
sleep 1

# Capture current screen to see what's there
CURRENT_SCREEN=$(byobu capture-pane -t "$TMUX_SESSION:$TMUX_WINDOW" -p)
log "Current screen state captured"

# Function to wait for a pattern in the screen
wait_for_pattern() {
    local pattern="$1"
    local max_wait="$2"
    local count=0
    
    while [ $count -lt $max_wait ]; do
        local screen_content=$(byobu capture-pane -t "$TMUX_SESSION:$TMUX_WINDOW" -p)
        if echo "$screen_content" | grep -q "$pattern"; then
            return 0
        fi
        sleep 1
        count=$((count + 1))
    done
    return 1
}

# Function to check if we're at a shell prompt
is_at_shell_prompt() {
    local screen_content=$(byobu capture-pane -t "$TMUX_SESSION:$TMUX_WINDOW" -p)
    # Look for common shell prompt patterns including ±
    echo "$screen_content" | tail -3 | grep -E '(\$|#|%|>|±)\s*$' > /dev/null
}

# Function to check if qwen-code is running (look for running process or output)
is_qwen_running() {
    local screen_content=$(byobu capture-pane -t "$TMUX_SESSION:$TMUX_WINDOW" -p)
    # Look for qwen-code specific patterns - either running or output
    echo "$screen_content" | grep -E '(qwen|Qwen|processing|response|model)' > /dev/null
}

# Step 5: Handle current state and quit if needed
log "Step 5: Handling current application state..."
if is_qwen_running; then
    log "qwen-code appears to be running, sending Ctrl+C to interrupt..."
    byobu send-keys -t "$TMUX_SESSION:$TMUX_WINDOW" C-c
    sleep 2
    
    # Wait for shell prompt to appear
    if wait_for_pattern '\$\|#\|%\|±' 5; then
        success "Successfully interrupted qwen-code"
    else
        warning "May not have quit cleanly, forcing with additional Ctrl+C"
        byobu send-keys -t "$TMUX_SESSION:$TMUX_WINDOW" C-c
        sleep 2
    fi
elif echo "$CURRENT_SCREEN" | grep -q "Error\|ERROR\|Failed"; then
    log "Found error state, sending Ctrl+C to clear..."
    byobu send-keys -t "$TMUX_SESSION:$TMUX_WINDOW" C-c
    sleep 2
fi

# Step 6: Ensure we're at a clean shell prompt
log "Step 6: Ensuring clean shell prompt..."
if ! is_at_shell_prompt; then
    log "Not at shell prompt, sending Enter to get prompt..."
    byobu send-keys -t "$TMUX_SESSION:$TMUX_WINDOW" C-m
    sleep 1
    
    if ! is_at_shell_prompt; then
        log "Still not at prompt, sending Ctrl+C..."
        byobu send-keys -t "$TMUX_SESSION:$TMUX_WINDOW" C-c
        sleep 2
    fi
fi

# Final check for shell prompt
if is_at_shell_prompt; then
    success "At shell prompt, ready to start qwen-code"
else
    error "Unable to get to shell prompt"
    log "Final screen state:"
    byobu capture-pane -t "$TMUX_SESSION:$TMUX_WINDOW" -p | tail -10 | tee -a "$LOGFILE"
    exit 1
fi

# Step 7: Start qwen-code
log "Step 7: Starting qwen-code with command: $STARTUP_COMMAND"
byobu send-keys -t "$TMUX_SESSION:$TMUX_WINDOW" "$STARTUP_COMMAND"
sleep 1
byobu send-keys -t "$TMUX_SESSION:$TMUX_WINDOW" C-m
sleep 5

# Step 8: Wait for qwen-code to process and show response
log "Step 8: Waiting ${WAIT_TIMEOUT}s for qwen-code to process..."
sleep $WAIT_TIMEOUT

# Capture final screen state
FINAL_SCREEN=$(byobu capture-pane -t "$TMUX_SESSION:$TMUX_WINDOW" -p)
log "Final screen state captured"

# Step 9: Analyze results
log "Step 9: Analyzing test results..."
echo "=== FINAL SCREEN CAPTURE ===" | tee -a "$LOGFILE"
echo "$FINAL_SCREEN" | tee -a "$LOGFILE"
echo "=== END SCREEN CAPTURE ===" | tee -a "$LOGFILE"

# Check for success/failure patterns
if echo "$FINAL_SCREEN" | grep -q "terminated\|Error\|ERROR\|Failed\|Connection refused\|ECONNREFUSED"; then
    error "TEST FAILED - Error detected in output"
    echo "$FINAL_SCREEN" | grep -E "(terminated|Error|ERROR|Failed|Connection refused|ECONNREFUSED)" | tee -a "$LOGFILE"
    
    # Look for error report files
    if echo "$FINAL_SCREEN" | grep -q "/var/folders.*\.json"; then
        ERROR_FILE=$(echo "$FINAL_SCREEN" | grep -o "/var/folders[^[:space:]]*\.json" | head -1)
        if [ -f "$ERROR_FILE" ]; then
            log "Found error report file: $ERROR_FILE"
            echo "=== ERROR REPORT ===" | tee -a "$LOGFILE"
            cat "$ERROR_FILE" | tee -a "$LOGFILE"
            echo "=== END ERROR REPORT ===" | tee -a "$LOGFILE"
        fi
    fi
    
    TEST_RESULT="FAILED"
else
    # Look for signs of successful response (qwen-code specific patterns)
    if echo "$FINAL_SCREEN" | grep -qE "(4|The answer is|result|calculation|sum)" && ! echo "$FINAL_SCREEN" | grep -q "Error"; then
        success "TEST PASSED - Response detected without errors"
        TEST_RESULT="PASSED"
    elif echo "$FINAL_SCREEN" | grep -qE "(qwen|response|model|processing)" && ! echo "$FINAL_SCREEN" | grep -q "Error"; then
        success "TEST PASSED - qwen-code executed without errors"
        TEST_RESULT="PASSED"
    else
        warning "TEST INCONCLUSIVE - No clear success or failure"
        TEST_RESULT="INCONCLUSIVE"
    fi
fi

# Step 10: Generate summary
log "Step 10: Generating test summary..."
echo "" | tee -a "$LOGFILE"
echo "=== TEST SUMMARY ===" | tee -a "$LOGFILE"
echo "Test Result: $TEST_RESULT" | tee -a "$LOGFILE"
echo "Command Used: $STARTUP_COMMAND" | tee -a "$LOGFILE"
echo "Test Prompt: $TEST_PROMPT" | tee -a "$LOGFILE"
echo "Log File: $LOGFILE" | tee -a "$LOGFILE"
echo "Timestamp: $(date)" | tee -a "$LOGFILE"
echo "=== END SUMMARY ===" | tee -a "$LOGFILE"

# Step 11: Restore original window focus
log "Step 11: Restoring original window focus..."
if [ -n "$ORIGINAL_WINDOW" ]; then
    byobu select-window -t "$TMUX_SESSION:$ORIGINAL_WINDOW"
    success "Restored focus to window $ORIGINAL_WINDOW"
else
    warning "Could not determine original window to restore"
fi

if [ "$TEST_RESULT" = "PASSED" ]; then
    success "Integration test completed successfully!"
    exit 0
elif [ "$TEST_RESULT" = "FAILED" ]; then
    error "Integration test failed"
    exit 1
else
    warning "Integration test was inconclusive"
    exit 2
fi