/**
 * Update User Preferences Handler
 *
 * Updates stored user preferences (name, timezone, location, language, notes).
 * Uses an injected updatePreferences callback to avoid depending on @craft-agent/shared.
 */

import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

export interface UpdatePreferencesArgs {
  name?: string;
  timezone?: string;
  city?: string;
  region?: string;
  country?: string;
  language?: string;
  notes?: string;
  includeCoAuthoredBy?: boolean;
}

/**
 * Handle the update_user_preferences tool call.
 *
 * Validates and merges preference updates, then delegates to the
 * context-provided updatePreferences callback for actual persistence.
 */
export async function handleUpdatePreferences(
  ctx: SessionToolContext,
  args: UpdatePreferencesArgs
): Promise<ToolResult> {
  if (!ctx.updatePreferences) {
    return errorResponse('Preferences update is not available in this environment.');
  }

  try {
    const updates: Record<string, unknown> = {};

    if (args.name && typeof args.name === 'string') {
      updates.name = args.name;
    }
    if (args.timezone && typeof args.timezone === 'string') {
      updates.timezone = args.timezone;
    }
    if (args.language && typeof args.language === 'string') {
      updates.language = args.language;
    }

    // Handle location fields
    if (args.city || args.region || args.country) {
      const location: Record<string, string> = {};
      if (args.city && typeof args.city === 'string') {
        location.city = args.city;
      }
      if (args.region && typeof args.region === 'string') {
        location.region = args.region;
      }
      if (args.country && typeof args.country === 'string') {
        location.country = args.country;
      }
      updates.location = location;
    }

    // Handle notes (replace)
    if (args.notes && typeof args.notes === 'string') {
      updates.notes = args.notes;
    }

    // Handle co-author preference (explicit boolean)
    if (typeof args.includeCoAuthoredBy === 'boolean') {
      updates.includeCoAuthoredBy = args.includeCoAuthoredBy;
    }

    // Check if anything was actually updated
    const fields = Object.keys(updates).filter(k => k !== 'location');
    if (updates.location) {
      fields.push(...Object.keys(updates.location as Record<string, string>).map(k => `location.${k}`));
    }

    if (fields.length === 0) {
      return successResponse('No preferences were updated (no valid fields provided)');
    }

    ctx.updatePreferences(updates);
    return successResponse(`Updated user preferences: ${fields.join(', ')}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`Failed to update preferences: ${message}`);
  }
}
