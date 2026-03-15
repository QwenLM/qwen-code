/**
 * Microphone button for voice input
 * 
 * Shows a mic button that pulses red when recording.
 * Click to start/stop voice input.
 */

import type { FC } from 'react';
import { MicrophoneIcon } from '../icons/MicrophoneIcon.js';
import { StopIcon } from '../icons/StopIcon.js';

/**
 * Props for VoiceInputButton component
 */
export interface VoiceInputButtonProps {
  /** Whether voice input is currently listening */
  isListening: boolean;
  /** Whether speech recognition is supported */
  isSupported: boolean;
  /** Whether an error occurred */
  hasError: boolean;
  /** Callback to start listening */
  onStartListening: () => void;
  /** Callback to stop listening */
  onStopListening: () => void;
}

/**
 * VoiceInputButton component
 */
export const VoiceInputButton: FC<VoiceInputButtonProps> = ({
  isListening,
  isSupported,
  hasError,
  onStartListening,
  onStopListening,
}) => {
  const handleClick = () => {
    if (isListening) {
      onStopListening();
    } else {
      onStartListening();
    }
  };

  // Don't render if not supported
  if (!isSupported) {
    return null;
  }

  return (
    <div className={`relative group`}>
      <button
        type="button"
        onClick={handleClick}
        disabled={!isSupported}
        className={`
          flex items-center justify-center
          w-8 h-8 rounded-md
          transition-all duration-200
          focus:outline-none focus:ring-2 focus:ring-offset-1
          ${
            isListening
              ? 'bg-red-500 hover:bg-red-600 text-white animate-pulse'
              : hasError
                ? 'bg-orange-500 hover:bg-orange-600 text-white'
                : 'bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-600 dark:text-gray-300'
          }
          disabled:opacity-50 disabled:cursor-not-allowed
        `}
        title={isListening ? 'Stop recording' : hasVoiceError ? 'Microphone error - click to retry' : 'Voice input'}
        aria-label={isListening ? 'Stop recording' : 'Voice input'}
      >
        {isListening ? (
          <StopIcon className="w-4 h-4" />
        ) : (
          <MicrophoneIcon className="w-4 h-4" />
        )}
      </button>

      {/* Tooltip */}
      <div
        className={`
          absolute px-2 py-1 text-xs font-medium text-white bg-gray-900 rounded
          opacity-0 group-hover:opacity-100 transition-opacity duration-200
          pointer-events-none whitespace-nowrap z-50
          bottom-full left-1/2 -translate-x-1/2 mb-2
        `}
      >
        {isListening ? 'Stop recording' : 'Voice input'}
      </div>
    </div>
  );
};
