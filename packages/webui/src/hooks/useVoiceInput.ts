/**
 * Voice recognition hook for speech-to-text
 * 
 * Simple hook that handles voice recording and transcription
 * using the browser's built-in Web Speech API.
 */

import { useState, useEffect, useCallback, useRef } from 'react';

// Type definitions for Web Speech API
interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

interface SpeechRecognitionResultList {
  length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
  isFinal: boolean;
  length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onstart: ((this: SpeechRecognition, ev: Event) => void) | null;
  onend: ((this: SpeechRecognition, ev: Event) => void) | null;
  onresult: ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => void) | null;
  onerror: ((this: SpeechRecognition, ev: Event) => void) | null;
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognition;
  prototype: SpeechRecognition;
}

// Global type augmentation for browser support
declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

/**
 * Voice input state
 */
export interface VoiceInputState {
  /** Whether voice is currently recording */
  isListening: boolean;
  /** Current transcribed text */
  transcript: string;
  /** Whether browser supports speech recognition */
  isSupported: boolean;
  /** Error message if something went wrong */
  error: string | null;
  /** Whether an error occurred */
  hasError: boolean;
}

/**
 * Voice input hook
 * 
 * Provides speech-to-text using the Web Speech API.
 * Works in Chrome, Edge, and VS Code Desktop.
 * 
 * @returns Voice input state and controls
 */
export function useVoiceInput() {
  const [state, setState] = useState<VoiceInputState>({
    isListening: false,
    transcript: '',
    isSupported: false,
    error: null,
    hasError: false,
  });

  const recognitionRef = useRef<SpeechRecognition | null>(null);

  // Initialize speech recognition on mount
  useEffect(() => {
    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      setState((prev) => ({
        ...prev,
        isSupported: false,
        error: 'Speech recognition is not supported in this browser',
      }));
      return;
    }

    try {
      const recognition = new SpeechRecognition();
      recognitionRef.current = recognition;

      // Configure recognition
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'en-US';

      // Handle start event
      recognition.onstart = () => {
        setState((prev) => ({
          ...prev,
          isListening: true,
          hasError: false,
          error: null,
        }));
      };

      // Handle end event
      recognition.onend = () => {
        setState((prev) => ({
          ...prev,
          isListening: false,
        }));
      };

      // Handle results
      recognition.onresult = (event: SpeechRecognitionEvent) => {
        let finalTranscript = '';
        let interimTranscript = '';

        for (let i = event.resultIndex; i < event.results.length; ++i) {
          const result = event.results[i];
          if (result.isFinal) {
            finalTranscript += result[0]?.transcript || '';
          } else {
            interimTranscript += result[0]?.transcript || '';
          }
        }

        setState((prev) => ({
          ...prev,
          transcript: prev.transcript + finalTranscript + interimTranscript,
          hasError: false,
          error: null,
        }));
      };

      // Handle errors
      recognition.onerror = (event: Event) => {
        const errorEvent = event as Event & { error?: string };
        let errorMessage = 'An error occurred during speech recognition';

        switch (errorEvent.error) {
          case 'no-speech':
            errorMessage = 'No speech detected. Please try again.';
            break;
          case 'audio-capture':
            errorMessage = 'No microphone found. Please check your microphone.';
            break;
          case 'not-allowed':
            errorMessage = 'Permission denied. Please allow microphone access.';
            break;
          case 'network':
            errorMessage = 'Network error. Please check your connection.';
            break;
          default:
            errorMessage = `Error: ${errorEvent.error || 'Unknown error'}`;
        }

        setState((prev) => ({
          ...prev,
          isListening: false,
          hasError: true,
          error: errorMessage,
        }));
      };

      isSupportedRef.current = true;
      setState((prev) => ({
        ...prev,
        isSupported: true,
      }));
    } catch (error) {
      setState((prev) => ({
        ...prev,
        isSupported: false,
        hasError: true,
        error: error instanceof Error ? error.message : 'Failed to initialize speech recognition',
      }));
    }

    // Cleanup on unmount
    return () => {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch {
          // Ignore errors during cleanup
        }
        recognitionRef.current = null;
      }
    };
  }, []);

  /**
   * Start listening for voice input
   */
  const startListening = useCallback(() => {
    if (!recognitionRef.current || !state.isSupported) {
      return;
    }

    setState((prev) => ({
      ...prev,
      transcript: '',
      hasError: false,
      error: null,
    }));

    try {
      recognitionRef.current.start();
    } catch (error) {
      setState((prev) => ({
        ...prev,
        hasError: true,
        error: error instanceof Error ? error.message : 'Failed to start listening',
      }));
    }
  }, [state.isSupported]);

  /**
   * Stop listening for voice input
   */
  const stopListening = useCallback(() => {
    if (!recognitionRef.current) {
      return;
    }

    try {
      recognitionRef.current.stop();
    } catch (error) {
      // Ignore errors during stop
    }
  }, []);

  /**
   * Clear the current transcript
   */
  const clearTranscript = useCallback(() => {
    setState((prev) => ({
      ...prev,
      transcript: '',
    }));
  }, []);

  /**
   * Set the transcript directly (for editing)
   */
  const setTranscript = useCallback((text: string) => {
    setState((prev) => ({
      ...prev,
      transcript: text,
    }));
  }, []);

  return {
    // State
    isListening: state.isListening,
    transcript: state.transcript,
    isSupported: state.isSupported,
    error: state.error,
    hasError: state.hasError,

    // Controls
    startListening,
    stopListening,
    clearTranscript,
    setTranscript,
  };
}
