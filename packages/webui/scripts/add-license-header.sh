#!/bin/bash

# Script to check and add license header to files in the packages/webui directory
# If a file doesn't have the required license header, it will be added at the top
# Excludes Markdown files and common build/dependency directories

LICENSE_HEADER="/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */"

# Directory to scan (relative to script location)
TARGET_DIR="$(dirname "$0")/../"

# Find all JavaScript, TypeScript, CSS, HTML, and JSX/TSX files in the target directory, excluding Markdown files
# Also exclude common build/dependency directories
find "$TARGET_DIR" -type f \( -name "*.js" -o -name "*.jsx" -o -name "*.ts" -o -name "*.tsx" -o -name "*.cjs" -o -name "*.mjs" -o -name "*.css" -o -name "*.html" \) -not -name "*.md" \
  -not -path "*/node_modules/*" \
  -not -path "*/dist/*" \
  -not -path "*/build/*" \
  -not -path "*/coverage/*" \
  -not -path "*/.next/*" \
  -not -path "*/out/*" \
  -not -path "*/target/*" \
  -not -path "*/vendor/*" \
  -print0 | while IFS= read -r -d '' file; do
    # Skip the script file itself
    if [[ "$(basename "$file")" != "add-license-header.sh" ]]; then
        # Check if the file starts with the license header
        if ! head -n 5 "$file" | grep -Fq "@license"; then
            echo "Adding license header to: $file"

            # Create a temporary file with the license header followed by the original content
            temp_file=$(mktemp)
            echo "$LICENSE_HEADER" > "$temp_file"
            echo "" >> "$temp_file"  # Add an empty line after the license header
            cat "$file" >> "$temp_file"

            # Move the temporary file to replace the original file
            mv "$temp_file" "$file"
        else
            echo "License header already present in: $file"
        fi
    fi
done

echo "License header check and update completed."