## Problem

When reading PDF files, the API returns "Invalid value: file. Supported values are: 'text','image_url','video_url' and 'video'." error. Worse, this error state persists in the session, causing all subsequent requests to fail with the same error.

Fixes #2020

## Root Cause

Gemini API's FunctionResponse does not support PDF (`application/pdf`) in the `parts` field. When a tool returns PDF content as inlineData, it gets passed through to the API, which rejects it.

## Changes

- Add PDF (`application/pdf`) to unsupported media types in `convertUnsupportedMediaToText()`
- PDF content in tool responses is now converted to explanatory text instead of being sent as inlineData
- This prevents the API error and allows the session to continue normally

## Testing

- Added test case for PDF inlineData conversion
- Added test case for PDF fileData conversion
- All 11 tests in geminiContentGenerator.test.ts pass
