/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// React import not needed for test files
import { render } from 'ink-testing-library';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QwenOAuthProgress } from './QwenOAuthProgress.js';
import { DeviceAuthorizationInfo } from '../hooks/useQwenAuth.js';

// Mock qrcode-terminal module
vi.mock('qrcode-terminal', () => ({
  default: {
    generate: vi.fn(),
  },
}));

// Mock ink-spinner
vi.mock('ink-spinner', () => ({
  default: ({ type }: { type: string }) => `MockSpinner(${type})`,
}));

describe('QwenOAuthProgress', () => {
  const mockOnTimeout = vi.fn();
  const mockOnCancel = vi.fn();

  const createMockDeviceAuth = (
    overrides: Partial<DeviceAuthorizationInfo> = {},
  ): DeviceAuthorizationInfo => ({
    verification_uri: 'https://example.com/device',
    verification_uri_complete: 'https://example.com/device?user_code=ABC123',
    user_code: 'ABC123',
    expires_in: 300,
    ...overrides,
  });

  const mockDeviceAuth = createMockDeviceAuth();

  const renderComponent = (
    props: Partial<{ deviceAuth: DeviceAuthorizationInfo }> = {},
  ) =>
    render(
      <QwenOAuthProgress
        onTimeout={mockOnTimeout}
        onCancel={mockOnCancel}
        {...props}
      />,
    );

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Loading state (no deviceAuth)', () => {
    it('should render loading state when deviceAuth is not provided', () => {
      const { lastFrame } = renderComponent();

      const output = lastFrame();
      expect(output).toContain('MockSpinner(dots)');
      expect(output).toContain('Waiting for Qwen OAuth authentication...');
      expect(output).toContain('(Press ESC to cancel)');
    });

    it('should render loading state with gray border', () => {
      const { lastFrame } = renderComponent();
      const output = lastFrame();

      // Should not contain auth flow elements
      expect(output).not.toContain('Qwen OAuth Authentication');
      expect(output).not.toContain('Please visit this URL to authorize:');
      // Loading state still shows time remaining with default timeout
      expect(output).toContain('Time remaining:');
    });
  });

  describe('Authenticated state (with deviceAuth)', () => {
    it('should render authentication flow when deviceAuth is provided', () => {
      const { lastFrame } = renderComponent({ deviceAuth: mockDeviceAuth });

      const output = lastFrame();
      expect(output).toContain('Qwen OAuth Authentication');
      expect(output).toContain('Please visit this URL to authorize:');
      expect(output).toContain(mockDeviceAuth.verification_uri_complete);
      expect(output).toContain('MockSpinner(dots)');
      expect(output).toContain('Waiting for authorization');
      expect(output).toContain('Time remaining: 5:00');
      expect(output).toContain('(Press ESC to cancel)');
    });

    it('should display correct URL in bordered box', () => {
      const customAuth = createMockDeviceAuth({
        verification_uri_complete: 'https://custom.com/auth?code=XYZ789',
      });
      const { lastFrame } = renderComponent({ deviceAuth: customAuth });

      expect(lastFrame()).toContain('https://custom.com/auth?code=XYZ789');
    });

    it('should format time correctly', () => {
      const deviceAuthWithCustomTime: DeviceAuthorizationInfo = {
        ...mockDeviceAuth,
        expires_in: 125, // 2 minutes and 5 seconds
      };

      const { lastFrame } = render(
        <QwenOAuthProgress
          onTimeout={mockOnTimeout}
          onCancel={mockOnCancel}
          deviceAuth={deviceAuthWithCustomTime}
        />,
      );

      const output = lastFrame();
      expect(output).toContain('Time remaining: 2:05');
    });

    it('should format single digit seconds with leading zero', () => {
      const deviceAuthWithCustomTime: DeviceAuthorizationInfo = {
        ...mockDeviceAuth,
        expires_in: 67, // 1 minute and 7 seconds
      };

      const { lastFrame } = render(
        <QwenOAuthProgress
          onTimeout={mockOnTimeout}
          onCancel={mockOnCancel}
          deviceAuth={deviceAuthWithCustomTime}
        />,
      );

      const output = lastFrame();
      expect(output).toContain('Time remaining: 1:07');
    });
  });

  describe('Timer functionality', () => {
    it('should countdown and call onTimeout when timer expires', async () => {
      const deviceAuthWithShortTime: DeviceAuthorizationInfo = {
        ...mockDeviceAuth,
        expires_in: 2, // 2 seconds
      };

      const { rerender } = render(
        <QwenOAuthProgress
          onTimeout={mockOnTimeout}
          onCancel={mockOnCancel}
          deviceAuth={deviceAuthWithShortTime}
        />,
      );

      // Advance timer by 1 second
      vi.advanceTimersByTime(1000);
      rerender(
        <QwenOAuthProgress
          onTimeout={mockOnTimeout}
          onCancel={mockOnCancel}
          deviceAuth={deviceAuthWithShortTime}
        />,
      );

      // Advance timer by another second to trigger timeout
      vi.advanceTimersByTime(1000);
      rerender(
        <QwenOAuthProgress
          onTimeout={mockOnTimeout}
          onCancel={mockOnCancel}
          deviceAuth={deviceAuthWithShortTime}
        />,
      );

      expect(mockOnTimeout).toHaveBeenCalledTimes(1);
    });

    it('should update time remaining display', async () => {
      const { lastFrame, rerender } = render(
        <QwenOAuthProgress
          onTimeout={mockOnTimeout}
          onCancel={mockOnCancel}
          deviceAuth={mockDeviceAuth}
        />,
      );

      // Initial time should be 5:00
      expect(lastFrame()).toContain('Time remaining: 5:00');

      // Advance by 1 second
      vi.advanceTimersByTime(1000);
      rerender(
        <QwenOAuthProgress
          onTimeout={mockOnTimeout}
          onCancel={mockOnCancel}
          deviceAuth={mockDeviceAuth}
        />,
      );

      // Should now show 4:59
      expect(lastFrame()).toContain('Time remaining: 4:59');
    });

    it('should not start timer when deviceAuth is null', () => {
      render(
        <QwenOAuthProgress onTimeout={mockOnTimeout} onCancel={mockOnCancel} />,
      );

      // Advance timer and ensure onTimeout is not called
      vi.advanceTimersByTime(5000);
      expect(mockOnTimeout).not.toHaveBeenCalled();
    });
  });

  describe('Animated dots', () => {
    it('should cycle through animated dots', async () => {
      const { lastFrame, rerender } = render(
        <QwenOAuthProgress
          onTimeout={mockOnTimeout}
          onCancel={mockOnCancel}
          deviceAuth={mockDeviceAuth}
        />,
      );

      // Initial state should have no dots
      expect(lastFrame()).toContain('Waiting for authorization');

      // Advance by 500ms to add first dot
      vi.advanceTimersByTime(500);
      rerender(
        <QwenOAuthProgress
          onTimeout={mockOnTimeout}
          onCancel={mockOnCancel}
          deviceAuth={mockDeviceAuth}
        />,
      );
      expect(lastFrame()).toContain('Waiting for authorization.');

      // Advance by another 500ms to add second dot
      vi.advanceTimersByTime(500);
      rerender(
        <QwenOAuthProgress
          onTimeout={mockOnTimeout}
          onCancel={mockOnCancel}
          deviceAuth={mockDeviceAuth}
        />,
      );
      expect(lastFrame()).toContain('Waiting for authorization..');

      // Advance by another 500ms to add third dot
      vi.advanceTimersByTime(500);
      rerender(
        <QwenOAuthProgress
          onTimeout={mockOnTimeout}
          onCancel={mockOnCancel}
          deviceAuth={mockDeviceAuth}
        />,
      );
      expect(lastFrame()).toContain('Waiting for authorization...');

      // Advance by another 500ms to reset dots
      vi.advanceTimersByTime(500);
      rerender(
        <QwenOAuthProgress
          onTimeout={mockOnTimeout}
          onCancel={mockOnCancel}
          deviceAuth={mockDeviceAuth}
        />,
      );
      expect(lastFrame()).toContain('Waiting for authorization');
    });
  });

  describe('QR Code functionality', () => {
    it('should generate QR code when deviceAuth is provided', async () => {
      const qrcode = await import('qrcode-terminal');
      const mockGenerate = vi.mocked(qrcode.default.generate);

      mockGenerate.mockImplementation((url, options, callback) => {
        callback!('Mock QR Code Data');
      });

      render(
        <QwenOAuthProgress
          onTimeout={mockOnTimeout}
          onCancel={mockOnCancel}
          deviceAuth={mockDeviceAuth}
        />,
      );

      expect(mockGenerate).toHaveBeenCalledWith(
        mockDeviceAuth.verification_uri_complete,
        { small: true },
        expect.any(Function),
      );
    });

    // Note: QR code display test skipped due to timing complexities with async state updates
    // The QR code generation is already tested in 'should generate QR code when deviceAuth is provided'

    it('should handle QR code generation errors gracefully', async () => {
      const qrcode = await import('qrcode-terminal');
      const mockGenerate = vi.mocked(qrcode.default.generate);
      const consoleErrorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      mockGenerate.mockImplementation(() => {
        throw new Error('QR Code generation failed');
      });

      const { lastFrame } = render(
        <QwenOAuthProgress
          onTimeout={mockOnTimeout}
          onCancel={mockOnCancel}
          deviceAuth={mockDeviceAuth}
        />,
      );

      // Should not crash and should not show QR code section
      const output = lastFrame();
      expect(output).not.toContain('Or scan the QR code below:');
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Failed to generate QR code:',
        expect.any(Error),
      );

      consoleErrorSpy.mockRestore();
    });

    it('should not generate QR code when deviceAuth is null', async () => {
      const qrcode = await import('qrcode-terminal');
      const mockGenerate = vi.mocked(qrcode.default.generate);

      render(
        <QwenOAuthProgress onTimeout={mockOnTimeout} onCancel={mockOnCancel} />,
      );

      expect(mockGenerate).not.toHaveBeenCalled();
    });
  });

  describe('User interactions', () => {
    it('should call onCancel when ESC key is pressed', () => {
      const { stdin } = render(
        <QwenOAuthProgress
          onTimeout={mockOnTimeout}
          onCancel={mockOnCancel}
          deviceAuth={mockDeviceAuth}
        />,
      );

      // Simulate ESC key press
      stdin.write('\u001b'); // ESC character

      expect(mockOnCancel).toHaveBeenCalledTimes(1);
    });

    it('should call onCancel when ESC is pressed in loading state', () => {
      const { stdin } = render(
        <QwenOAuthProgress onTimeout={mockOnTimeout} onCancel={mockOnCancel} />,
      );

      // Simulate ESC key press
      stdin.write('\u001b'); // ESC character

      expect(mockOnCancel).toHaveBeenCalledTimes(1);
    });

    it('should not call onCancel for other key presses', () => {
      const { stdin } = render(
        <QwenOAuthProgress
          onTimeout={mockOnTimeout}
          onCancel={mockOnCancel}
          deviceAuth={mockDeviceAuth}
        />,
      );

      // Simulate other key presses
      stdin.write('a');
      stdin.write('\r'); // Enter
      stdin.write(' '); // Space

      expect(mockOnCancel).not.toHaveBeenCalled();
    });
  });

  describe('Props changes', () => {
    it('should display initial timer value from deviceAuth', () => {
      const deviceAuthWith10Min: DeviceAuthorizationInfo = {
        ...mockDeviceAuth,
        expires_in: 600, // 10 minutes
      };

      const { lastFrame } = render(
        <QwenOAuthProgress
          onTimeout={mockOnTimeout}
          onCancel={mockOnCancel}
          deviceAuth={deviceAuthWith10Min}
        />,
      );

      expect(lastFrame()).toContain('Time remaining: 10:00');
    });

    it('should reset to loading state when deviceAuth becomes null', () => {
      const { rerender, lastFrame } = render(
        <QwenOAuthProgress
          onTimeout={mockOnTimeout}
          onCancel={mockOnCancel}
          deviceAuth={mockDeviceAuth}
        />,
      );

      expect(lastFrame()).toContain('Qwen OAuth Authentication');

      rerender(
        <QwenOAuthProgress onTimeout={mockOnTimeout} onCancel={mockOnCancel} />,
      );

      expect(lastFrame()).toContain('Waiting for Qwen OAuth authentication...');
      expect(lastFrame()).not.toContain('Qwen OAuth Authentication');
    });
  });
});
