#!/bin/bash

# Clean up build artifacts and temporary files for Chrome Extension

echo "Cleaning up Chrome Extension build artifacts..."

# Remove build output
rm -rf extension/sidepanel/dist/sidepanel-app.js
rm -rf extension/sidepanel/dist/sidepanel-app.js.map

# Remove any zip files
rm -f chrome-extension.zip

# Remove log files
rm -f /tmp/qwen-bridge-host.log
rm -f /tmp/qwen-server.log

# Remove saved extension ID
rm -f .extension-id

# Remove any dist directories
rm -rf dist/

echo "Cleanup complete!"
