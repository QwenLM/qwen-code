/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '../core/contentGenerator.js';
import { ModelRegistry } from './modelRegistry.js';
import {
  type ResolvedModelConfig,
  type AvailableModel,
  type ModelSwitchMetadata,
  type CurrentModelInfo,
  type ModelProvidersConfig,
  SelectionSource,
} from './types.js';

/**
 * Callback type for when the model changes.
 * This is used to notify Config to update the ContentGenerator.
 */
export type ModelChangeCallback = (
  authType: AuthType,
  model: ResolvedModelConfig,
) => Promise<void>;

/**
 * Options for initializing the ModelSelectionManager
 */
export interface ModelSelectionManagerOptions {
  /** Initial authType from persisted settings */
  initialAuthType?: AuthType;
  /** Initial model ID from persisted settings */
  initialModelId?: string;
  /** Callback when model changes */
  onModelChange?: ModelChangeCallback;
  /** Model providers configuration for creating ModelRegistry */
  modelProvidersConfig?: ModelProvidersConfig;
}

/**
 * Manages model and auth selection with persistence.
 * Two-level selection: authType → model
 */
export class ModelSelectionManager {
  private modelRegistry: ModelRegistry;

  // Current selection state
  private currentAuthType: AuthType;
  private currentModelId: string;

  // Selection metadata for tracking and observability
  private selectionSource: SelectionSource = SelectionSource.DEFAULT;
  private selectionTimestamp: number = Date.now();

  // Callback for model changes
  private onModelChange?: ModelChangeCallback;

  constructor(options: ModelSelectionManagerOptions = {}) {
    // Create ModelRegistry internally - it's an implementation detail
    this.modelRegistry = new ModelRegistry(options.modelProvidersConfig);
    this.onModelChange = options.onModelChange;

    // Initialize from options or use defaults
    this.currentAuthType = options.initialAuthType || AuthType.QWEN_OAUTH;
    this.currentModelId = options.initialModelId || '';

    // Validate and initialize selection
    this.initializeDefaultSelection(options);
  }

  /**
   * Initialize default selection
   */
  private initializeDefaultSelection(
    _options: ModelSelectionManagerOptions,
  ): void {
    // Check if persisted model selection is valid
    if (
      this.currentModelId &&
      this.modelRegistry.hasModel(this.currentAuthType, this.currentModelId)
    ) {
      this.selectionSource = SelectionSource.SETTINGS;
      return;
    }

    // Check environment variables (backward compatibility)
    const envModel = this.getModelFromEnvironment();
    if (
      envModel &&
      this.modelRegistry.hasModel(this.currentAuthType, envModel)
    ) {
      this.currentModelId = envModel;
      this.selectionSource = SelectionSource.ENVIRONMENT;
      return;
    }

    // Use registry default (first model for current authType)
    const defaultModel = this.modelRegistry.getDefaultModelForAuthType(
      this.currentAuthType,
    );
    if (defaultModel) {
      this.currentModelId = defaultModel.id;
      this.selectionSource = SelectionSource.DEFAULT;
    }
  }

  /**
   * Get model from environment variables (backward compatibility)
   */
  private getModelFromEnvironment(): string | undefined {
    // Support legacy OPENAI_MODEL env var for openai authType
    if (this.currentAuthType === AuthType.USE_OPENAI) {
      return process.env['OPENAI_MODEL'];
    }
    return undefined;
  }

  /**
   * Switch model within current authType.
   * This updates model name and generation config.
   */
  async switchModel(
    modelId: string,
    source: SelectionSource,
    _metadata?: ModelSwitchMetadata,
  ): Promise<void> {
    // Validate model exists for current authType
    const model = this.modelRegistry.getModel(this.currentAuthType, modelId);
    if (!model) {
      throw new Error(
        `Model '${modelId}' not found for authType '${this.currentAuthType}'`,
      );
    }

    // Store previous model for rollback if needed
    const previousModelId = this.currentModelId;

    try {
      // Update selection state
      this.currentModelId = modelId;
      this.selectionSource = source;
      this.selectionTimestamp = Date.now();

      // Notify about the change
      if (this.onModelChange) {
        await this.onModelChange(this.currentAuthType, model);
      }
    } catch (error) {
      // Rollback on error
      this.currentModelId = previousModelId;
      throw error;
    }
  }

  /**
   * Get available models for current authType.
   * Used by /model command to show only relevant models.
   */
  getAvailableModels(): AvailableModel[] {
    return this.modelRegistry.getModelsForAuthType(this.currentAuthType);
  }

  /**
   * Get available authTypes.
   * Used by /auth command.
   */
  getAvailableAuthTypes(): AuthType[] {
    return this.modelRegistry.getAvailableAuthTypes();
  }

  /**
   * Get current authType
   */
  getCurrentAuthType(): AuthType {
    return this.currentAuthType;
  }

  /**
   * Get current model ID
   */
  getCurrentModelId(): string {
    return this.currentModelId;
  }

  /**
   * Get current model information
   */
  getCurrentModel(): CurrentModelInfo {
    if (!this.currentModelId) {
      throw new Error('No model selected');
    }

    const model = this.modelRegistry.getModel(
      this.currentAuthType,
      this.currentModelId,
    );
    if (!model) {
      throw new Error(
        `Current model '${this.currentModelId}' not found for authType '${this.currentAuthType}'`,
      );
    }

    return {
      authType: this.currentAuthType,
      modelId: this.currentModelId,
      model,
      selectionSource: this.selectionSource,
    };
  }

  /**
   * Check if a model exists for the given authType.
   * Delegates to ModelRegistry.
   */
  hasModel(authType: AuthType, modelId: string): boolean {
    return this.modelRegistry.hasModel(authType, modelId);
  }

  /**
   * Get model configuration by authType and modelId.
   * Delegates to ModelRegistry.
   */
  getModel(
    authType: AuthType,
    modelId: string,
  ): ResolvedModelConfig | undefined {
    return this.modelRegistry.getModel(authType, modelId);
  }

  /**
   * Get the current selection source
   */
  getSelectionSource(): SelectionSource {
    return this.selectionSource;
  }

  /**
   * Get the timestamp of when the current selection was made
   */
  getSelectionTimestamp(): number {
    return this.selectionTimestamp;
  }

  /**
   * Update the onModelChange callback
   */
  setOnModelChange(callback: ModelChangeCallback): void {
    this.onModelChange = callback;
  }
}
