/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import type { HookPayload, HookContext } from './HookManager.js';
import { HookType } from './HookManager.js';
import type { HookConfigLoader } from './HookConfigLoader.js';
import * as path from 'node:path';

export class PayloadConverter {
  private config: Config;
  private configLoader: HookConfigLoader;

  constructor(config: Config, configLoader: HookConfigLoader) {
    this.config = config;
    this.configLoader = configLoader;
  }

  convertToClaudeFormat(
    qwenPayload: HookPayload,
    context: HookContext,
    hookType: HookType,
  ): Record<string, unknown> {
    const sessionId = context.config.getSessionId?.() || '';
    // Convert Qwen hook type to Claude event name
    const claudeEventName = this.convertHookTypeToClaudeEvent(hookType);
    // Construct the Claude-compatible payload
    const claudePayload: Record<string, unknown> = {
      session_id: sessionId,
      hook_event_name: claudeEventName,
      timestamp: qwenPayload.timestamp,
      ...this.convertToolInputFormat(qwenPayload, hookType),
    };
    // Add transcript_path if available
    const transcriptPath = this.getTranscriptPath(sessionId);
    if (transcriptPath) {
      claudePayload['transcript_path'] = transcriptPath;
    }
    return claudePayload;
  }

  processClaudeHookResponse(
    responseStr: string,
    hookType: HookType,
  ): Record<string, unknown> {
    try {
      // Parse the response from the Claude hook
      const response = JSON.parse(responseStr);
      // Process different response formats based on hook type and return relevant data
      if (hookType === HookType.BEFORE_TOOL_USE) {
        // Handle PreToolUse response format
        if (
          (response as Record<string, unknown>)['hookSpecificOutput'] &&
          (
            (response as Record<string, unknown>)[
              'hookSpecificOutput'
            ] as Record<string, unknown>
          )['hookEventName'] === 'PreToolUse'
        ) {
          // Check if there's also a top-level decision (mixed format)
          if (
            (response as Record<string, unknown>)['decision'] &&
            (response as Record<string, unknown>)['reason']
          ) {
            // Mixed format: both top-level decision and hookSpecificOutput
            const result: Record<string, unknown> = {
              decision: (response as Record<string, unknown>)['decision'],
              reason: (response as Record<string, unknown>)['reason'],
              systemMessage: (response as Record<string, unknown>)[
                'systemMessage'
              ],
              // Preserve the hookSpecificOutput object as a separate property as expected by tests
              hookSpecificOutput: (response as Record<string, unknown>)[
                'hookSpecificOutput'
              ],
            };
            // Add all hookSpecificOutput properties to the result (except hookEventName)
            const hookSpecificOutput1 = (response as Record<string, unknown>)[
              'hookSpecificOutput'
            ] as Record<string, unknown>;
            if (
              hookSpecificOutput1 &&
              typeof hookSpecificOutput1 === 'object'
            ) {
              for (const [key, value] of Object.entries(hookSpecificOutput1)) {
                if (key !== 'hookEventName') {
                  // exclude hookEventName from the result
                  result[key] = value;
                }
              }
            }
            // This would require deeper integration with the tool execution flow
            console.log(
              `PreToolUse hook decision: ${(response as Record<string, unknown>)['decision']}, reason: ${(response as Record<string, unknown>)['reason']}, systemMessage: ${(response as Record<string, unknown>)['systemMessage']}`,
            );
            return result;
          } else {
            // Pure hookSpecificOutput format: only hookSpecificOutput fields
            const hookSpecificOutputRaw = (response as Record<string, unknown>)[
              'hookSpecificOutput'
            ];
            const decision =
              hookSpecificOutputRaw && typeof hookSpecificOutputRaw === 'object'
                ? ((hookSpecificOutputRaw as Record<string, unknown>)[
                    'permissionDecision'
                  ] as string)
                : undefined;
            const reason =
              hookSpecificOutputRaw && typeof hookSpecificOutputRaw === 'object'
                ? ((hookSpecificOutputRaw as Record<string, unknown>)[
                    'permissionDecisionReason'
                  ] as string)
                : undefined;
            const systemMessage = (response as Record<string, unknown>)[
              'systemMessage'
            ];
            const updatedInput =
              hookSpecificOutputRaw && typeof hookSpecificOutputRaw === 'object'
                ? ((hookSpecificOutputRaw as Record<string, unknown>)[
                    'updatedInput'
                  ] as Record<string, unknown>)
                : undefined;
            // Create the result object by merging hookSpecificOutput properties with top-level properties
            const result: Record<string, unknown> = {
              permissionDecision: decision,
              permissionDecisionReason: reason,
              systemMessage,
              updatedInput,
              // Preserve the hookSpecificOutput object as a separate property as expected by tests
              hookSpecificOutput: (response as Record<string, unknown>)[
                'hookSpecificOutput'
              ],
            };
            // Add all other hookSpecificOutput properties to the result (except hookEventName)
            if (
              hookSpecificOutputRaw &&
              typeof hookSpecificOutputRaw === 'object'
            ) {
              for (const [key, value] of Object.entries(
                hookSpecificOutputRaw,
              )) {
                if (key !== 'hookEventName') {
                  // exclude hookEventName from the result
                  result[key] = value;
                }
              }
            }
            // For PreToolUse with hookSpecificOutput, decision and reason are separate fields
            // The test expects decision to be undefined when using hookSpecificOutput (without top-level decision)
            (result as Record<string, unknown>)['decision'] = undefined;
            (result as Record<string, unknown>)['reason'] = undefined;
            // This would require deeper integration with the tool execution flow
            console.log(
              `PreToolUse hook decision: ${decision}, reason: ${reason}, systemMessage: ${systemMessage}`,
            );
            // Log updated input if present
            if (updatedInput) {
              console.log(`updated input: ${JSON.stringify(updatedInput)}`);
            }
            return result;
          }
        } else if ((response as Record<string, unknown>)['decision']) {
          // Handle PreToolUse response without hookSpecificOutput
          const result: Record<string, unknown> = {
            decision: (response as Record<string, unknown>)['decision'],
            reason: (response as Record<string, unknown>)['reason'],
            systemMessage: (response as Record<string, unknown>)[
              'systemMessage'
            ],
          };
          return result;
        }
      } else if (hookType === HookType.AFTER_TOOL_USE) {
        // Handle PostToolUse response format
        if ((response as Record<string, unknown>)['decision']) {
          const result: Record<string, unknown> = {
            decision: (response as Record<string, unknown>)['decision'],
            reason: (response as Record<string, unknown>)['reason'],
            systemMessage: (response as Record<string, unknown>)[
              'systemMessage'
            ],
          };
          // If there's a hookSpecificOutput, add its properties to the result and preserve the object
          const hookSpecificOutputForPost = (
            response as Record<string, unknown>
          )['hookSpecificOutput'];
          if (
            hookSpecificOutputForPost &&
            typeof hookSpecificOutputForPost === 'object'
          ) {
            // Add all hookSpecificOutput properties to the result (except hookEventName)
            for (const [key, value] of Object.entries(
              hookSpecificOutputForPost,
            )) {
              if (key !== 'hookEventName') {
                // exclude hookEventName from the result
                result[key] = value;
              }
            }
            // Preserve the hookSpecificOutput object as a separate property as expected by tests
            (result as Record<string, unknown>)['hookSpecificOutput'] = (
              response as Record<string, unknown>
            )['hookSpecificOutput'];
          }
          console.log(
            `PostToolUse hook: ${(response as Record<string, unknown>)['decision']} decision, reason: ${(response as Record<string, unknown>)['reason']}, systemMessage: ${(response as Record<string, unknown>)['systemMessage']}`,
          );
          return result;
        }
      } else if (hookType === HookType.SESSION_END) {
        // Handle Stop hook response format
        if ((response as Record<string, unknown>)['decision']) {
          const result: Record<string, unknown> = {
            decision: (response as Record<string, unknown>)['decision'],
            reason: (response as Record<string, unknown>)['reason'],
            systemMessage: (response as Record<string, unknown>)[
              'systemMessage'
            ],
          };
          console.log(
            `Stop/SubagentStop hook: ${(response as Record<string, unknown>)['decision']} decision, reason: ${(response as Record<string, unknown>)['reason']}, systemMessage: ${(response as Record<string, unknown>)['systemMessage']}`,
          );
          return result;
        }
      } else if (hookType === HookType.INPUT_RECEIVED) {
        // Handle UserPromptSubmit response format
        if ((response as Record<string, unknown>)['decision']) {
          const result: Record<string, unknown> = {
            decision: (response as Record<string, unknown>)['decision'],
            reason: (response as Record<string, unknown>)['reason'],
            systemMessage: (response as Record<string, unknown>)[
              'systemMessage'
            ],
          };
          // For UserPromptSubmit, updatedInput would be the modified user input
          const hookSpecificOutputVal = (response as Record<string, unknown>)[
            'hookSpecificOutput'
          ];
          const updatedInput =
            (hookSpecificOutputVal && typeof hookSpecificOutputVal === 'object'
              ? (hookSpecificOutputVal as Record<string, unknown>)[
                  'updatedInput'
                ]
              : undefined) ||
            (response as Record<string, unknown>)['updatedInput'];
          if (updatedInput) {
            (result as Record<string, unknown>)['updatedInput'] = updatedInput;
          }
          // If there's a hookSpecificOutput, add its properties to the result and preserve the object
          const hookSpecificOutputForInput = (
            response as Record<string, unknown>
          )['hookSpecificOutput'];
          if (
            hookSpecificOutputForInput &&
            typeof hookSpecificOutputForInput === 'object'
          ) {
            // Add all hookSpecificOutput properties to the result (except hookEventName)
            for (const [key, value] of Object.entries(
              hookSpecificOutputForInput,
            )) {
              if (key !== 'hookEventName') {
                // exclude hookEventName from the result
                result[key] = value;
              }
            }
            // Preserve the hookSpecificOutput object as a separate property as expected by tests
            (result as Record<string, unknown>)['hookSpecificOutput'] = (
              response as Record<string, unknown>
            )['hookSpecificOutput'];
          }
          console.log(
            `UserPromptSubmit hook: ${(response as Record<string, unknown>)['decision']} decision, reason: ${(response as Record<string, unknown>)['reason']}, systemMessage: ${(response as Record<string, unknown>)['systemMessage']}, updatedInput: ${JSON.stringify(updatedInput)}`,
          );
          return result;
        }
      }
      // For responses that don't match our expected formats, return the entire response
      return response || {};
    } catch (error) {
      console.error(
        `Error processing Claude hook response: ${error}, Raw response: ${responseStr}`,
      );
      return {};
    }
  }

  convertToolInputFormat(
    payload: HookPayload,
    hookType: HookType,
  ): Record<string, unknown> {
    // Check if this is a PreToolUse hook payload and convert tool input to Claude format
    if (
      hookType === HookType.BEFORE_TOOL_USE &&
      (payload as Record<string, unknown>)['params']
    ) {
      const toolNameRaw =
        (payload as Record<string, unknown>)['toolName'] ||
        (payload as Record<string, unknown>)['tool_name'] ||
        (payload as Record<string, unknown>)['tool'];
      const toolName =
        typeof toolNameRaw === 'string' ? toolNameRaw : undefined;
      if (toolName) {
        // Map Qwen tool name to Claude tool name for lookup
        const claudeToolName = this.mapQwenToClaudeToolName(toolName);
        const toolInputFormatMappings = this.loadToolInputFormatMappings();
        const mapping = toolInputFormatMappings[claudeToolName] as
          | {
              claudeFieldMapping?: Record<string, string>;
            }
          | undefined;
        if (mapping) {
          const toolInput: Record<string, unknown> = {};
          // Map each Qwen field to its Claude equivalent
          const claudeFieldMapping = mapping['claudeFieldMapping'];
          if (claudeFieldMapping) {
            for (const [qwenField, claudeField] of Object.entries(
              claudeFieldMapping,
            )) {
              if (
                (payload as Record<string, unknown>)['params'] &&
                Object.prototype.hasOwnProperty.call(
                  (payload as Record<string, unknown>)['params'],
                  qwenField,
                )
              ) {
                toolInput[claudeField] = (
                  (payload as Record<string, unknown>)['params'] as Record<
                    string,
                    unknown
                  >
                )[qwenField];
              }
            }
          }
          return {
            tool_name: claudeToolName,
            tool_input: toolInput,
          };
        }
      }
    }
    // Return original payload fields if no specific conversion needed
    return payload;
  }

  private convertHookTypeToClaudeEvent(hookType: HookType): string {
    // Load event mappings from configuration using the config loader
    const eventMappings = this.configLoader.loadHookEventMappings();
    // Find the Claude event name that corresponds to this Qwen hook type
    for (const [claudeEvent, qwenHookType] of Object.entries(eventMappings)) {
      if (qwenHookType === hookType) {
        return claudeEvent;
      }
    }
    // If no mapping is found, return a default conversion
    return hookType.replace(/\./g, '');
  }

  getTranscriptPath(sessionId: string): string | null {
    try {
      // Return a path where the transcript for this session would be stored
      // This is a placeholder implementation - actual path would depend on where
      // Qwen stores transcripts
      const chatsDir = path.join(
        this.config.storage.getProjectTempDir(),
        'chats',
      );
      // Find the session file for this session ID
      // In a real implementation, you'd look for the actual transcript file
      return path.join(chatsDir, `session-${sessionId}.json`);
    } catch (error) {
      console.warn('Could not determine transcript path:', error);
      return null;
    }
  }

  private loadToolInputFormatMappings(): Record<string, unknown> {
    // Use the config loader to get the actual mappings
    return this.configLoader.loadToolInputFormatMappings();
  }

  private mapQwenToClaudeToolName(qwenToolName: string): string {
    // Use the config loader to get the actual mapping
    return this.configLoader.mapQwenToClaudeToolName(qwenToolName);
  }
}
