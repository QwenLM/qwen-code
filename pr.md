# 🚀 Enhance Your Rough Prompt, Now Available in Qwen

> This PR adds a new prompt enhancement feature that allows users to improve their prompts using AI assistance.

## ✨ Features Added

- **🤖 AI-Powered Prompt Enhancement**: Users can press `Ctrl+B` to send their current prompt to Qwen AI for improvement
- **Seamless Integration**: Enhanced prompts automatically replace the original text in the input field  
- **Visual Feedback**: Footer shows enhancement status ("Enhance Prompt (Ctrl+B)" when idle, "Enhancing..." during processing)
- **Keyboard Shortcut**: `Ctrl+B` trigger that avoids conflicts with existing shortcuts

## 🔧 Technical Implementation

- **New Hook**: `usePromptEnhancement` for handling AI prompt improvement requests
- **Key Binding**: Added `ENHANCE_PROMPT` command to the keyboard shortcut system  
- **UI Integration**: Updated InputPrompt and Footer components with enhancement functionality
- **Error Handling**: Proper loading states and error management

## 🧪 Testing

-  All existing tests pass (32/32)
-  Updated UI snapshots to reflect new functionality  
-  No regressions in existing features

## 📝 How to Use

1. **Type** your prompt in the input field
2. **Press** `Ctrl+B` to enhance the prompt
3. **Watch** the enhanced version replace your original text
4. **Submit** the improved prompt

---

**💡 Summary**: This feature helps users write clearer, more effective prompts by leveraging AI assistance directly within the interface.