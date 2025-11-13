#!/bin/bash

FILTER_PATH=""

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -f|--filter)
            FILTER_PATH="$2"
            shift
            shift
            ;;
        *)
            echo "Usage: $0 [-f|--filter PATH]"
            echo "Example: $0 --filter packages/core/src/hooks/"
            exit 1
            ;;
    esac
done

echo "Running comprehensive lint and code quality checks..."
if [ -n "$FILTER_PATH" ]; then
    echo "Filtering for path: $FILTER_PATH"
fi
echo "====================================================="

# Run typecheck and capture output
echo "1. Running TypeScript typecheck..."
npx tsc --noEmit --listEmittedFiles false 2>&1 | grep "error TS" > typecheck_errors.txt
if [ -n "$FILTER_PATH" ]; then
    grep "$FILTER_PATH" typecheck_errors.txt > temp_typecheck_errors.txt
    mv temp_typecheck_errors.txt typecheck_errors.txt
fi
echo "   - TypeScript errors: $(wc -l < typecheck_errors.txt)"

# Run ESLint
echo "2. Running ESLint..."
npx eslint --ext .ts,.tsx,.js,.jsx . 2>&1 | grep -E "error|warning" > eslint_output.txt
if [ -n "$FILTER_PATH" ]; then
    grep "$FILTER_PATH" eslint_output.txt > temp_eslint_output.txt
    mv temp_eslint_output.txt eslint_output.txt
fi
echo "   - ESLint issues: $(wc -l < eslint_output.txt)"

# Run Prettier check
echo "3. Running Prettier check..."
npx prettier --check . 2>&1 | grep -E "error|not formatted" > prettier_output.txt
if [ -n "$FILTER_PATH" ]; then
    grep "$FILTER_PATH" prettier_output.txt > temp_prettier_output.txt
    mv temp_prettier_output.txt prettier_output.txt
fi
echo "   - Prettier issues: $(wc -l < prettier_output.txt)"

# Group and summarize TypeScript errors by file
echo ""
echo "TypeScript Errors by File:"
echo "=========================="
if [ -s typecheck_errors.txt ]; then
    echo ""
    awk -F'[()]' '{print $1}' typecheck_errors.txt | cut -d: -f1 | sort | uniq -c | sort -nr
else
    echo "No TypeScript errors found."
fi

echo ""
echo "Top TypeScript Error Types:"
echo "==========================="
if [ -s typecheck_errors.txt ]; then
    grep -o "error TS[0-9]*" typecheck_errors.txt | sort | uniq -c | sort -nr | head -10
else
    echo "No TypeScript errors found."
fi

echo ""
echo "ESLint Issues by File:"
echo "======================="
if [ -s eslint_output.txt ]; then
    echo ""
    grep -E "^.+:\d+:\d+" eslint_output.txt | cut -d: -f1 | sort | uniq -c | sort -nr
else
    echo "No ESLint issues found."
fi

echo ""
echo "Summary:"
echo "========"
echo "TypeScript errors: $(wc -l < typecheck_errors.txt)"
echo "ESLint issues: $(wc -l < eslint_output.txt)"
echo "Prettier issues: $(wc -l < prettier_output.txt)"

# Clean up temporary files
rm -f typecheck_errors.txt eslint_output.txt prettier_output.txt