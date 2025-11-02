/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  CommandContext,
  SlashCommand,
  SlashCommandActionReturn,
} from './types.js';
import { getCurrentGeminiMdFilename } from '@qwen-code/qwen-code-core';
import { CommandKind } from './types.js';
import { Text } from 'ink';
import React from 'react';

// 定义多语言内容模板，使用占位符，在实际使用时替换
const createLanguageTemplate = (contextFileName: string) => ({
  en: `You are Qwen Code, an interactive CLI agent. Analyze the current directory and generate a comprehensive ${contextFileName} file to be used as instructional context for future interactions.

**Analysis Process:**

1.  **Initial Exploration:**
    *   Start by listing the files and directories to get a high-level overview of the structure.
    *   Read the README file (e.g., \`README.md\`, \`README.txt\`) if it exists. This is often the best place to start.

2.  **Iterative Deep Dive (up to 10 files):**
    *   Based on your initial findings, select a few files that seem most important (e.g., configuration files, main source files, documentation).
    *   Read them. As you learn more, refine your understanding and decide which files to read next. You don't need to decide all 10 files at once. Let your discoveries guide your exploration.

3.  **Identify Project Type:**
    *   **Code Project:** Look for clues like \`package.json\`, \`requirements.txt\`, \`pom.xml\`, \`go.mod\`, \`Cargo.toml\`, \`build.gradle\`, or a \`src\` directory. If you find them, this is likely a software project.
    *   **Non-Code Project:** If you don't find code-related files, this might be a directory for documentation, research papers, notes, or something else.

**${contextFileName} Content Generation:**

**For a Code Project:**

*   **Project Overview:** Write a clear and concise summary of the project's purpose, main technologies, and architecture.
*   **Building and Running:** Document the key commands for building, running, and testing the project. Infer these from the files you've read (e.g., \`scripts\` in \`package.json\`, \`Makefile\`, etc.). If you can't find explicit commands, provide a placeholder with a TODO.
*   **Development Conventions:** Describe any coding styles, testing practices, or contribution guidelines you can infer from the codebase.

**For a Non-Code Project:**

*   **Directory Overview:** Describe the purpose and contents of the directory. What is it for? What kind of information does it hold?
*   **Key Files:** List the most important files and briefly explain what they contain.
*   **Usage:** Explain how the contents of this directory are intended to be used.

**Final Output:**

Write the complete content to the \`${contextFileName}\` file. The output must be well-formatted Markdown.
`,
  cn: `您是Qwen Code，一个交互式CLI助手。分析当前目录并生成一个全面的${contextFileName}文件，用作未来交互的指导上下文。

**分析过程：**

1.  **初步探索：**
    *   首先列出文件和目录，以获得结构的总体概览。
    *   如果存在，阅读README文件（例如\`README.md\`、\`README.txt\`）。这通常是最好的起点。

2.  **迭代深入研究（最多10个文件）：**
    *   基于您的初步发现，选择几个看起来最重要的文件（例如配置文件、主源文件、文档）。
    *   阅读它们。随着了解的深入，完善您的理解并决定接下来要阅读哪个文件。您不需要一次性决定所有10个文件。让您的发现指导您的探索。

3.  **识别项目类型：**
    *   **代码项目：** 寻找线索，如\`package.json\`、\`requirements.txt\`、\`pom.xml\`、\`go.mod\`、\`Cargo.toml\`、\`build.gradle\`或\`src\`目录。如果找到它们，这可能是一个软件项目。
    *   **非代码项目：** 如果没有找到相关代码文件，这可能是用于文档、研究论文、笔记或其他内容的目录。

**${contextFileName} 内容生成：**

**对于代码项目：**

*   **项目概述：** 简明扼要地总结项目的目的、主要技术和架构。
*   **构建和运行：** 记录用于构建、运行和测试项目的关键命令。从您读过的文件中推断这些（例如\`package.json\`中的\`scripts\`、\`Makefile\`等）。如果您找不到明确的命令，请使用TODO提供占位符。
*   **开发约定：** 描述您可以从代码库中推断出的任何编码风格、测试实践或贡献指南。

**对于非代码项目：**

*   **目录概述：** 描述目录的用途和内容。它是做什么的？它包含什么信息？
*   **重要文件：** 列出最重要的文件并简要说明它们包含什么。
*   **使用方法：** 解释该目录的内容如何使用。

**最终输出：**

将完整内容写入 \`${contextFileName}\` 文件。输出必须是格式良好的Markdown。
`,
  jp: `あなたはQwen Codeであり、対話式CLIエージェントです。現在のディレクトリを分析し、将来のインタラクションの指示コンテキストとして使用する包括的な${contextFileName}ファイルを生成してください。

**分析プロセス：**

1.  **初期探索：**
    *   ファイルとディレクトリを一覧表示して、構造の概要を把握してください。
    *   存在する場合はREADMEファイル（例：\`README.md\`、\`README.txt\`）を読む。これは通常最良の開始点です。

2.  **反復的深掘り（最大10ファイル）：**
    *   最初の発見に基づいて、最も重要なファイル（例：設定ファイル、メインのソースファイル、ドキュメント）をいくつか選択してください。
    *   それらを読みます。さらに多くの情報を得るにつれて理解を深め、次にどのファイルを読むかを決定してください。すべての10ファイルを一度に決定する必要はありません。発見が探索を導くようにしてください。

3.  **プロジェクトタイプの識別：**
    *   **コードプロジェクト：** \`package.json\`、\`requirements.txt\`、\`pom.xml\`、\`go.mod\`、\`Cargo.toml\`、\`build.gradle\`、または\`src\`ディレクトリなどの手がかりを探してください。これらが見つかった場合、これはソフトウェアプロジェクトである可能性が高いです。
    *   **非コードプロジェクト：** コード関連ファイルが見つからない場合、これはドキュメント、研究論文、ノート、またはその他を対象としたディレクトリかもしれません。

**${contextFileName}コンテンツ生成：**

**コードプロジェクトの場合：**

*   **プロジェクト概要：** プロジェクトの目的、主要技術、アーキテクチャについて明確かつ簡潔に要約してください。
*   **ビルドと実行：** プロジェクトのビルド、実行、テストのための主要コマンドを文書化します。読んだファイルから推測してください（例：\`package.json\`の\`scripts\`、\`Makefile\`など）。明確なコマンドが見つからない場合は、TODOでプレースホルダーを提供してください。
*   **開発規約：** コードベースから推測できるコーディングスタイル、テスト手法、貢献ガイドラインについて説明してください。

**非コードプロジェクトの場合：**

*   **ディレクトリ概要：** ディレクトリの目的と内容を説明してください。これは何のためのものですか？どのような情報が含まれていますか？
*   **主要ファイル：** 最も重要なファイルを一覧表示し、各ファイルが何を含んでいるかを簡単に説明してください。
*   **使用方法：** このディレクトリの内容がどのように使用されるかを説明してください。

**最終出力：**

完全なコンテンツを\`${contextFileName}\`ファイルに書き込んでください。出力はフォーマットされたMarkdownでなければなりません。
`,
  kr: `당신은 Qwen Code이며, 대화형 CLI 에이전트입니다. 현재 디렉토리를 분석하고 향후 상호작용을 위한 지침 컨텍스트로 사용할 포괄적인 ${contextFileName} 파일을 생성하십시오.

**분석 절차:**

1.  **초기 탐색:**
    *   파일과 디렉토리를 나열하여 구조에 대한 개요를 파악하십시오.
    *   존재하는 경우 README 파일(예: \`README.md\`, \`README.txt\`)을 읽으십시오. 이는 보통 가장 좋은 출발점입니다.

2.  **반복적 심층 탐구(최대 10개 파일):**
    *   초기 조사 결과를 기반으로 가장 중요한 것으로 보이는 몇 가지 파일(예: 구성 파일, 주요 소스 파일, 문서)을 선택하십시오.
    *   해당 파일들을 읽으십시오. 더 많은 정보를 얻으면 이해를 정제하고 다음에 어떤 파일을 읽을지 결정하십시오. 10개 파일을 모두 한 번에 결정할 필요는 없습니다. 발견한 내용이 탐구를 이끌도록 하십시오.

3.  **프로젝트 유형 식별:**
    *   **코드 프로젝트:** \`package.json\`, \`requirements.txt\`, \`pom.xml\`, \`go.mod\`, \`Cargo.toml\`, \`build.gradle\`, 또는 \`src\` 디렉토리와 같은 단서를 찾으십시오. 이러한 파일을 찾았다면 일반적으로 소프트웨어 프로젝트일 가능성이 높습니다.
    *   **비코드 프로젝트:** 코드 관련 파일을 찾지 못했다면 문서, 연구 논문, 노트 또는 기타 내용을 위한 디렉토리일 수 있습니다.

**${contextFileName} 콘텐츠 생성:**

**코드 프로젝트의 경우:**

*   **프로젝트 개요:** 프로젝트 목적, 주요 기술 및 아키텍처를 명확하고 간결하게 요약하십시오.
*   **빌드 및 실행:** 프로젝트를 빌드하고 실행하며 테스트하는 주요 명령을 문서화하십시오. 읽은 파일에서 추론하십시오(예: \`package.json\`의 \`scripts\`, \`Makefile\` 등). 명확한 명령을 찾을 수 없는 경우 TODO가 포함된 자리 표시자를 제공하십시오.
*   **개발 규칙:** 코드베이스에서 추론할 수 있는 모든 코딩 스타일, 테스트 관행 또는 기여 지침을 설명하십시오.

**비코드 프로젝트의 경우:**

*   **디렉토리 개요:** 디렉토리의 목적과 내용을 설명하십시오. 이것이 무엇을 위한 것인지, 어떤 정보를 보유하고 있는지 설명하십시오.
*   **핵심 파일:** 가장 중요한 파일을 나열하고 각 파일이 무엇을 포함하는지 간략히 설명하십시오.
*   **사용법:** 이 디렉토리의 내용이 어떻게 사용되는지를 설명하십시오.

**최종 출력:**

전체 콘텐츠를 \`${contextFileName}\` 파일에 작성하십시오. 출력은 형식이 지정된 Markdown이어야 합니다.
`
});

// 系统语言检测函数
const detectSystemLanguage = (): string => {
  // 使用 Node.js 的内置国际化支持来检测系统语言
  const systemLocale = process.env['LC_ALL'] || 
                     process.env['LC_MESSAGES'] || 
                     process.env['LANG'] || 
                     process.env['LANGUAGE'];
  
  if (systemLocale) {
    // 从 locale 设置中提取语言代码
    const match = systemLocale.toLowerCase().match(/^([a-z]{2})/);
    if (match) {
      const langCode = match[1];
      // 支持的语言映射
      const supportedLangs: Record<string, string> = {
        en: 'en',
        zh: 'cn',
        ja: 'jp',
        ko: 'kr',
        'zh-cn': 'cn',
        'zh-tw': 'cn',
        'ja-jp': 'jp',
        'ko-kr': 'kr'
      };
      
      // 检查精确匹配
      if (supportedLangs[systemLocale.toLowerCase()]) {
        return supportedLangs[systemLocale.toLowerCase()];
      }
      
      // 检查语言代码匹配
      if (supportedLangs[langCode]) {
        return supportedLangs[langCode];
      }
    }
  }
  
  // 使用操作系统的默认语言
  const osLocale = typeof navigator !== 'undefined' ? (navigator as { language?: string }).language || process.env['npm_config_language'];
  if (osLocale) {
    const langCode = osLocale.substring(0, 2).toLowerCase();
    const langMap: Record<string, string> = {
      'zh': 'cn',
      'ja': 'jp',
      'ko': 'kr',
      'en': 'en'
    };
    if (langMap[langCode]) {
      return langMap[langCode];
    }
  }
  
  // 如果无法检测到或不支持，则返回默认语言
  return 'en';
};

export const initCommand: SlashCommand = {
  name: 'init',
  description: 'Analyzes the project and creates a tailored QWEN.md file. Supports language parameter: /init [en|cn|jp|kr]',
  kind: CommandKind.BUILT_IN,
  action: async (
    context: CommandContext,
    args: string,
  ): Promise<SlashCommandActionReturn> => {
    if (!context.services.config) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Configuration not available.',
      };
    }
    
    // 解析参数以获取语言选项
    const trimmedArgs = args.trim().toLowerCase();
    let language = 'en'; // 默认为英文
    
    // 如果用户提供了参数，优先使用用户的参数
    if (trimmedArgs) {
      if (['en', 'cn', 'jp', 'kr'].includes(trimmedArgs)) {
        language = trimmedArgs;
      } else {
        return {
          type: 'message',
          messageType: 'error',
          content: `Unsupported language: ${trimmedArgs}. Supported languages are: en, cn, jp, kr`,
        };
      }
    } else {
      // 如果用户没有提供参数，则自动检测系统语言
      language = detectSystemLanguage();
    }
    
    const targetDir = context.services.config.getTargetDir();
    const contextFileName = getCurrentGeminiMdFilename();
    const contextFilePath = path.join(targetDir, contextFileName);

    try {
      if (fs.existsSync(contextFilePath)) {
        // If file exists but is empty (or whitespace), continue to initialize
        try {
          const existing = fs.readFileSync(contextFilePath, 'utf8');
          if (existing && existing.trim().length > 0) {
            // File exists and has content - ask for confirmation to overwrite
            if (!context.overwriteConfirmed) {
              return {
                type: 'confirm_action',
                // TODO: Move to .tsx file to use JSX syntax instead of React.createElement
                // For now, using React.createElement to maintain .ts compatibility for PR review
                prompt: React.createElement(
                  Text,
                  null,
                  `A ${contextFileName} file already exists in this directory. Do you want to regenerate it?`,
                ),
                originalInvocation: {
                  raw: context.invocation?.raw || '/init',
                },
              };
            }
            // User confirmed overwrite, continue with regeneration
          }
        } catch {
          // If we fail to read, conservatively proceed to (re)create the file
        }
      }

      // Ensure an empty context file exists before prompting the model to populate it
      try {
        fs.writeFileSync(contextFilePath, '', 'utf8');
        context.ui.addItem(
          {
            type: 'info',
            text: `Empty ${contextFileName} created. Now analyzing the project to populate it in ${language.toUpperCase()} language (detected from system: ${language === detectSystemLanguage() && !trimmedArgs ? 'auto' : 'manual'}).`,
          },
          Date.now(),
        );
      } catch (err) {
        return {
          type: 'message',
          messageType: 'error',
          content: `Failed to create ${contextFileName}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    } catch (error) {
      return {
        type: 'message',
        messageType: 'error',
        content: `Unexpected error preparing ${contextFileName}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    // 根据语言返回相应的模板
    const templates = createLanguageTemplate(contextFileName);
    const template = (templates as Record<string, string>)[language] || templates.en;
    return {
      type: 'submit_prompt',
      content: template,
    };
  },
};
