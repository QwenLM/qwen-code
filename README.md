# Scheduled-task workspace visibility: review evidence

Screenshots for QwenLM/qwen-code issue #16383. Before: 00aef0598. After: 017e2ff3f. These are actual Chromium captures of WebShellWithProviders with synthetic daemon API fixtures. This evidence-only branch is not part of the implementation PR.

Desktop captures are 1280 x 900; narrow captures are 390 x 844. No model execution is represented.

Review follow-up at cdbf3a890dae35a75b5eba47ca72c4c955e3c744: seven browser scenarios passed, including multi-workspace long labels at 390 x 844. Both folder icons remained 12 x 12 px with ellipsis and no horizontal overflow. See review-multi-narrow-cards.png and review-multi-narrow.json.
