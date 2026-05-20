## 🎯 What's Changed
Fixes issue #4092 - Removes trailing space after Tab completion for directory paths.

## 📝 Description
Previously, completing a directory path with Tab would add a trailing space (e.g., `@src/components/ `), forcing users to delete it before continuing to the next level. This matches standard shell behavior where directories end with `/` and don't need spaces.

## ✅ Changes
- Added `isDirectory` flag to `Suggestion` and `CommandCompletionItem` interfaces  
- Updated `handleAutocomplete` logic to skip trailing space when `isDirectory === true`  
- Modified `getDirPathCompletions()` in `/dir add` command to return proper metadata  
- New test case verifying directory completions don't append trailing space  

## 🧪 Testing
- All unit tests passing (49 tests)  
- Verified behavior: @path and /dir add completions now work seamlessly for nested directories
