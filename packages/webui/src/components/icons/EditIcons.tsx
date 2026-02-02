/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Edit mode related icons
 */

import type { FC } from 'react';
import type { IconProps } from './types.js';

/**
 * Edit pencil icon (16x16)
 * Used for "Ask before edits" mode
 */
export const EditPencilIcon: FC<IconProps> = ({
  size = 16,
  className,
  ...props
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 16 16"
    fill="currentColor"
    width={size}
    height={size}
    className={className}
    aria-hidden="true"
    {...props}
  >
    <path
      fillRule="evenodd"
      d="M11.013 2.513a1.75 1.75 0 0 1 2.475 2.474L6.226 12.25a2.751 2.751 0 0 1-.892.596l-2.047.848a.75.75 0 0 1-.98-.98l.848-2.047a2.75 2.75 0 0 1 .596-.892l7.262-7.261Z"
      clipRule="evenodd"
    />
  </svg>
);

/**
 * Auto/fast-forward icon (16x16)
 * Used for "Edit automatically" mode
 */
export const AutoEditIcon: FC<IconProps> = ({
  size = 16,
  className,
  ...props
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 16 16"
    fill="currentColor"
    width={size}
    height={size}
    className={className}
    aria-hidden="true"
    {...props}
  >
    <path d="M2.53 3.956A1 1 0 0 0 1 4.804v6.392a1 1 0 0 0 1.53.848l5.113-3.196c.16-.1.279-.233.357-.383v2.73a1 1 0 0 0 1.53.849l5.113-3.196a1 1 0 0 0 0-1.696L9.53 3.956A1 1 0 0 0 8 4.804v2.731a.992.992 0 0 0-.357-.383L2.53 3.956Z" />
  </svg>
);

/**
 * Plan mode/bars icon (16x16)
 * Used for "Plan mode"
 */
export const PlanModeIcon: FC<IconProps> = ({
  size = 16,
  className,
  ...props
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 16 16"
    fill="currentColor"
    width={size}
    height={size}
    className={className}
    aria-hidden="true"
    {...props}
  >
    <path d="M4.5 2a.5.5 0 0 0-.5.5v11a.5.5 0 0 0 .5.5h1a.5.5 0 0 0 .5-.5v-11a.5.5 0 0 0-.5-.5h-1ZM10.5 2a.5.5 0 0 0-.5.5v11a.5.5 0 0 0 .5.5h1a.5.5 0 0 0 .5-.5v-11a.5.5 0 0 0-.5-.5h-1Z" />
  </svg>
);

/**
 * Code brackets icon (20x20)
 * Used for active file indicator
 */
export const CodeBracketsIcon: FC<IconProps> = ({
  size = 20,
  className,
  ...props
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 20 20"
    fill="currentColor"
    width={size}
    height={size}
    className={className}
    aria-hidden="true"
    {...props}
  >
    <path
      fillRule="evenodd"
      d="M6.28 5.22a.75.75 0 0 1 0 1.06L2.56 10l3.72 3.72a.75.75 0 0 1-1.06 1.06L.97 10.53a.75.75 0 0 1 0-1.06l4.25-4.25a.75.75 0 0 1 1.06 0Zm7.44 0a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L17.44 10l-3.72-3.72a.75.75 0 0 1 0-1.06ZM11.377 2.011a.75.75 0 0 1 .612.867l-2.5 14.5a.75.75 0 0 1-1.478-.255l2.5-14.5a.75.75 0 0 1 .866-.612Z"
      clipRule="evenodd"
    />
  </svg>
);

/**
 * Hide context (eye slash) icon (20x20)
 * Used to indicate the active selection will NOT be auto-loaded into context
 */
export const HideContextIcon: FC<IconProps> = ({
  size = 20,
  className,
  ...props
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 20 20"
    fill="currentColor"
    width={size}
    height={size}
    className={className}
    aria-hidden="true"
    {...props}
  >
    <path
      fillRule="evenodd"
      d="M3.28 2.22a.75.75 0 0 0-1.06 1.06l14.5 14.5a.75.75 0 1 0 1.06-1.06l-1.745-1.745a10.029 10.029 0 0 0 3.3-4.38 1.651 1.651 0 0 0 0-1.185A10.004 10.004 0 0 0 9.999 3a9.956 9.956 0 0 0-4.744 1.194L3.28 2.22ZM7.752 6.69l1.092 1.092a2.5 2.5 0 0 1 3.374 3.373l1.091 1.092a4 4 0 0 0-5.557-5.557Z"
      clipRule="evenodd"
    />
    <path d="m10.748 13.93 2.523 2.523a9.987 9.987 0 0 1-3.27.547c-4.258 0-7.894-2.66-9.337-6.41a1.651 1.651 0 0 1 0-1.186A10.007 10.007 0 0 1 2.839 6.02L6.07 9.252a4 4 0 0 0 4.678 4.678Z" />
  </svg>
);

/**
 * Slash command icon (20x20)
 * Used for command menu button
 */
export const SlashCommandIcon: FC<IconProps> = ({
  size = 20,
  className,
  ...props
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 20 20"
    fill="currentColor"
    width={size}
    height={size}
    className={className}
    aria-hidden="true"
    {...props}
  >
    <path
      fillRule="evenodd"
      d="M12.528 3.047a.75.75 0 0 1 .449.961L8.433 16.504a.75.75 0 1 1-1.41-.512l4.544-12.496a.75.75 0 0 1 .961-.449Z"
      clipRule="evenodd"
    />
  </svg>
);

/**
 * Link/attachment icon (20x20)
 * Used for attach context button
 */
export const LinkIcon: FC<IconProps> = ({ size = 20, className, ...props }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 20 20"
    fill="currentColor"
    width={size}
    height={size}
    className={className}
    aria-hidden="true"
    {...props}
  >
    <path
      fillRule="evenodd"
      d="M15.621 4.379a3 3 0 0 0-4.242 0l-7 7a3 3 0 0 0 4.241 4.243h.001l.497-.5a.75.75 0 0 1 1.064 1.057l-.498.501-.002.002a4.5 4.5 0 0 1-6.364-6.364l7-7a4.5 4.5 0 0 1 6.368 6.36l-3.455 3.553A2.625 2.625 0 1 1 9.52 9.52l3.45-3.451a.75.75 0 1 1 1.061 1.06l-3.45 3.451a1.125 1.125 0 0 0 1.587 1.595l3.454-3.553a3 3 0 0 0 0-4.242Z"
      clipRule="evenodd"
    />
  </svg>
);

/**
 * Open diff icon (16x16)
 * Used for opening diff in VS Code
 */
export const OpenDiffIcon: FC<IconProps> = ({
  size = 16,
  className,
  ...props
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 16 16"
    fill="currentColor"
    width={size}
    height={size}
    className={className}
    aria-hidden="true"
    {...props}
  >
    <path d="M13.5 7l-4-4v3h-6v2h6v3l4-4z" />
  </svg>
);

/**
 * Undo edit icon (16x16)
 * Used for undoing edits in diff views
 */
export const UndoIcon: FC<IconProps> = ({ size = 16, className, ...props }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 16 16"
    fill="none"
    width={size}
    height={size}
    className={className}
    aria-hidden="true"
    {...props}
  >
    <path
      d="M9 10.6667L12.3333 14L9 17.3333M12.3333 14H4.66667C3.56112 14 2.66667 13.1056 2.66667 12V4.66667C2.66667 3.56112 3.56112 2.66667 4.66667 2.66667H13.3333C14.4389 2.66667 15.3333 3.56112 15.3333 4.66667V8.66667"
      stroke="currentColor"
      strokeWidth="1.33333"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/**
 * Redo edit icon (16x16)
 * Used for redoing edits in diff views
 */
export const RedoIcon: FC<IconProps> = ({ size = 16, className, ...props }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 16 16"
    fill="none"
    width={size}
    height={size}
    className={className}
    aria-hidden="true"
    {...props}
  >
    <path
      d="M7 10.6667L3.66667 14L7 17.3333M3.66667 14H11.3333C12.4389 14 13.3333 13.1056 13.3333 12V4.66667C13.3333 3.56112 12.4389 2.66667 11.3333 2.66667H2.66667C1.56112 2.66667 0.666667 3.56112 0.666667 4.66667V8.66667"
      stroke="currentColor"
      strokeWidth="1.33333"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/**
 * Replace all icon (16x16)
 * Used for replacing all occurrences in search/replace
 */
export const ReplaceAllIcon: FC<IconProps> = ({
  size = 16,
  className,
  ...props
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 16 16"
    fill="none"
    width={size}
    height={size}
    className={className}
    aria-hidden="true"
    {...props}
  >
    <path
      d="M11.3333 5.33333L14 8L11.3333 10.6667M14 8H6C3.79086 8 2 9.79086 2 12M2.66667 10.6667L0 8L2.66667 5.33333M2.66667 8H10C12.2091 8 14 6.20914 14 4V4"
      stroke="currentColor"
      strokeWidth="1.33333"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/**
 * Copy icon (16x16)
 * Used for copying content
 */
export const CopyIcon: FC<IconProps> = ({ size = 16, className, ...props }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 16 16"
    fill="none"
    width={size}
    height={size}
    className={className}
    aria-hidden="true"
    {...props}
  >
    <rect
      x="4.6665"
      y="4"
      width="8"
      height="8"
      rx="1.33333"
      stroke="currentColor"
      strokeWidth="1.33333"
    />
    <path
      d="M6 6H5.33333C4.04767 6 3 7.04767 3 8.33333V10.6667C3 11.9523 4.04767 13 5.33333 13H7.66667C8.95233 13 10 11.9523 10 10.6667V10"
      stroke="currentColor"
      strokeWidth="1.33333"
      strokeLinecap="round"
    />
  </svg>
);

/**
 * Paste icon (16x16)
 * Used for pasting content
 */
export const PasteIcon: FC<IconProps> = ({
  size = 16,
  className,
  ...props
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 16 16"
    fill="none"
    width={size}
    height={size}
    className={className}
    aria-hidden="true"
    {...props}
  >
    <path
      d="M5.3335 4.66669V4.00002C5.3335 3.62305 5.48315 3.26159 5.75181 2.99293C6.02047 2.72427 6.38193 2.57467 6.7589 2.57467H9.2589C9.63587 2.57467 9.99733 2.72427 10.266 2.99293C10.5346 3.26159 10.6842 3.62305 10.6842 4.00002V4.66669M12.0176 4.66669H12.6842C13.0612 4.66669 13.4227 4.81628 13.6913 5.08494C13.96 5.3536 14.1096 5.71506 14.1096 6.09203V10.9254C14.1096 11.3023 13.96 11.6638 13.6913 11.9325C13.4227 12.2011 13.0612 12.3507 12.6842 12.3507H3.35089C2.97392 12.3507 2.61246 12.2011 2.3438 11.9325C2.07514 11.6638 1.92554 11.3023 1.92554 10.9254V6.09203C1.92554 5.71506 2.07514 5.3536 2.3438 5.08494C2.61246 4.81628 2.97392 4.66669 3.35089 4.66669H4.01756M12.0176 4.66669V7.33335C12.0176 8.06973 11.7253 8.77607 11.2093 9.29205C10.6933 9.80803 9.98698 10.0999 9.2506 10.0999H6.77573C6.03935 10.0999 5.33301 9.80803 4.81703 9.29205C4.30105 8.77607 4.00918 8.06973 4.00918 7.33335V4.66669M12.0176 4.66669H4.01756"
      stroke="currentColor"
      strokeWidth="1.33333"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/**
 * Select all icon (16x16)
 * Used for selecting all content
 */
export const SelectAllIcon: FC<IconProps> = ({
  size = 16,
  className,
  ...props
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 16 16"
    fill="none"
    width={size}
    height={size}
    className={className}
    aria-hidden="true"
    {...props}
  >
    <rect
      x="2.6665"
      y="2"
      width="10.6667"
      height="12"
      rx="1.33333"
      stroke="currentColor"
      strokeWidth="1.33333"
    />
    <path
      d="M5.3335 5.33333H8.00016M5.3335 8H10.6668M5.3335 10.6667H10.6668"
      stroke="currentColor"
      strokeWidth="1.33333"
      strokeLinecap="round"
    />
  </svg>
);
