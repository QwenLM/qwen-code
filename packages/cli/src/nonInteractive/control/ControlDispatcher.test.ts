/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ControlDispatcher } from './ControlDispatcher.js';
import type { IControlContext } from './ControlContext.js';
import type { SystemController } from './controllers/systemController.js';
import type { StreamJsonOutputAdapter } from '../io/StreamJsonOutputAdapter.js';
import type {
  CLIControlRequest,
  CLIControlResponse,
  ControlResponse,
  ControlRequestPayload,
  CLIControlInitializeRequest,
  CLIControlInterruptRequest,
  CLIControlSetModelRequest,
  CLIControlSupportedCommandsRequest,
} from '../types.js';

/**
 * Creates a mock control context for testing
 */
function createMockContext(debugMode: boolean = false): IControlContext {
  const abortController = new AbortController();
  const mockStreamJson = {
    send: vi.fn(),
  } as unknown as StreamJsonOutputAdapter;

  const mockConfig = {
    getDebugMode: vi.fn().mockReturnValue(debugMode),
  };

  return {
    config: mockConfig as unknown as IControlContext['config'],
    streamJson: mockStreamJson,
    sessionId: 'test-session-id',
    abortSignal: abortController.signal,
    debugMode,
    permissionMode: 'default',
    sdkMcpServers: new Set<string>(),
    mcpClients: new Map(),
  };
}

/**
 * Creates a mock system controller for testing
 */
function createMockSystemController() {
  return {
    handleRequest: vi.fn(),
    sendControlRequest: vi.fn(),
    cleanup: vi.fn(),
  } as unknown as SystemController;
}

describe('ControlDispatcher', () => {
  let dispatcher: ControlDispatcher;
  let mockContext: IControlContext;
  let mockSystemController: SystemController;

  beforeEach(() => {
    mockContext = createMockContext();
    mockSystemController = createMockSystemController();

    // Mock SystemController constructor
    vi.doMock('./controllers/systemController.js', () => ({
      SystemController: vi.fn().mockImplementation(() => mockSystemController),
    }));

    dispatcher = new ControlDispatcher(mockContext);
    // Replace with mock controller for easier testing
    (
      dispatcher as unknown as { systemController: SystemController }
    ).systemController = mockSystemController;
  });

  describe('constructor', () => {
    it('should initialize with context and create controllers', () => {
      expect(dispatcher).toBeDefined();
      expect(dispatcher.systemController).toBeDefined();
    });

    it('should listen to abort signal and shutdown when aborted', () => {
      const abortController = new AbortController();

      const context = {
        ...createMockContext(),
        abortSignal: abortController.signal,
      };

      const newDispatcher = new ControlDispatcher(context);
      vi.spyOn(newDispatcher, 'shutdown');

      abortController.abort();

      // Give event loop a chance to process
      return new Promise<void>((resolve) => {
        setImmediate(() => {
          expect(newDispatcher.shutdown).toHaveBeenCalled();
          resolve();
        });
      });
    });
  });

  describe('dispatch', () => {
    it('should route initialize request to system controller', async () => {
      const request: CLIControlRequest = {
        type: 'control_request',
        request_id: 'req-1',
        request: {
          subtype: 'initialize',
        } as CLIControlInitializeRequest,
      };

      const mockResponse = {
        subtype: 'initialize',
        capabilities: { test: true },
      };

      vi.mocked(mockSystemController.handleRequest).mockResolvedValue(
        mockResponse,
      );

      await dispatcher.dispatch(request);

      expect(mockSystemController.handleRequest).toHaveBeenCalledWith(
        request.request,
        'req-1',
      );
      expect(mockContext.streamJson.send).toHaveBeenCalledWith({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'req-1',
          response: mockResponse,
        },
      });
    });

    it('should route interrupt request to system controller', async () => {
      const request: CLIControlRequest = {
        type: 'control_request',
        request_id: 'req-2',
        request: {
          subtype: 'interrupt',
        } as CLIControlInterruptRequest,
      };

      const mockResponse = { subtype: 'interrupt' };

      vi.mocked(mockSystemController.handleRequest).mockResolvedValue(
        mockResponse,
      );

      await dispatcher.dispatch(request);

      expect(mockSystemController.handleRequest).toHaveBeenCalledWith(
        request.request,
        'req-2',
      );
      expect(mockContext.streamJson.send).toHaveBeenCalledWith({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'req-2',
          response: mockResponse,
        },
      });
    });

    it('should route set_model request to system controller', async () => {
      const request: CLIControlRequest = {
        type: 'control_request',
        request_id: 'req-3',
        request: {
          subtype: 'set_model',
          model: 'test-model',
        } as CLIControlSetModelRequest,
      };

      const mockResponse = {
        subtype: 'set_model',
        model: 'test-model',
      };

      vi.mocked(mockSystemController.handleRequest).mockResolvedValue(
        mockResponse,
      );

      await dispatcher.dispatch(request);

      expect(mockSystemController.handleRequest).toHaveBeenCalledWith(
        request.request,
        'req-3',
      );
      expect(mockContext.streamJson.send).toHaveBeenCalledWith({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'req-3',
          response: mockResponse,
        },
      });
    });

    it('should route supported_commands request to system controller', async () => {
      const request: CLIControlRequest = {
        type: 'control_request',
        request_id: 'req-4',
        request: {
          subtype: 'supported_commands',
        } as CLIControlSupportedCommandsRequest,
      };

      const mockResponse = {
        subtype: 'supported_commands',
        commands: ['initialize', 'interrupt'],
      };

      vi.mocked(mockSystemController.handleRequest).mockResolvedValue(
        mockResponse,
      );

      await dispatcher.dispatch(request);

      expect(mockSystemController.handleRequest).toHaveBeenCalledWith(
        request.request,
        'req-4',
      );
      expect(mockContext.streamJson.send).toHaveBeenCalledWith({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'req-4',
          response: mockResponse,
        },
      });
    });

    it('should send error response when controller throws error', async () => {
      const request: CLIControlRequest = {
        type: 'control_request',
        request_id: 'req-5',
        request: {
          subtype: 'initialize',
        } as CLIControlInitializeRequest,
      };

      const error = new Error('Test error');
      vi.mocked(mockSystemController.handleRequest).mockRejectedValue(error);

      await dispatcher.dispatch(request);

      expect(mockContext.streamJson.send).toHaveBeenCalledWith({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: 'req-5',
          error: 'Test error',
        },
      });
    });

    it('should handle non-Error thrown values', async () => {
      const request: CLIControlRequest = {
        type: 'control_request',
        request_id: 'req-6',
        request: {
          subtype: 'initialize',
        } as CLIControlInitializeRequest,
      };

      vi.mocked(mockSystemController.handleRequest).mockRejectedValue(
        'String error',
      );

      await dispatcher.dispatch(request);

      expect(mockContext.streamJson.send).toHaveBeenCalledWith({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: 'req-6',
          error: 'String error',
        },
      });
    });

    it('should send error response for unknown request subtype', async () => {
      const request = {
        type: 'control_request' as const,
        request_id: 'req-7',
        request: {
          subtype: 'unknown_subtype',
        } as unknown as ControlRequestPayload,
      };

      await dispatcher.dispatch(request);

      // Dispatch catches errors and sends error response instead of throwing
      expect(mockContext.streamJson.send).toHaveBeenCalledWith({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: 'req-7',
          error: 'Unknown control request subtype: unknown_subtype',
        },
      });
    });
  });

  describe('handleControlResponse', () => {
    it('should resolve pending outgoing request on success response', () => {
      const requestId = 'outgoing-req-1';
      const response: CLIControlResponse = {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: requestId,
          response: { result: 'success' },
        },
      };

      // Register a pending outgoing request
      const resolve = vi.fn();
      const reject = vi.fn();
      const timeoutId = setTimeout(() => {}, 1000);

      // Access private method through type casting
      (
        dispatcher as unknown as {
          registerOutgoingRequest: (
            id: string,
            controller: string,
            resolve: (r: ControlResponse) => void,
            reject: (e: Error) => void,
            timeoutId: NodeJS.Timeout,
          ) => void;
        }
      ).registerOutgoingRequest(
        requestId,
        'SystemController',
        resolve,
        reject,
        timeoutId,
      );

      dispatcher.handleControlResponse(response);

      expect(resolve).toHaveBeenCalledWith(response.response);
      expect(reject).not.toHaveBeenCalled();
    });

    it('should reject pending outgoing request on error response', () => {
      const requestId = 'outgoing-req-2';
      const response: CLIControlResponse = {
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: requestId,
          error: 'Request failed',
        },
      };

      const resolve = vi.fn();
      const reject = vi.fn();
      const timeoutId = setTimeout(() => {}, 1000);

      (
        dispatcher as unknown as {
          registerOutgoingRequest: (
            id: string,
            controller: string,
            resolve: (r: ControlResponse) => void,
            reject: (e: Error) => void,
            timeoutId: NodeJS.Timeout,
          ) => void;
        }
      ).registerOutgoingRequest(
        requestId,
        'SystemController',
        resolve,
        reject,
        timeoutId,
      );

      dispatcher.handleControlResponse(response);

      expect(reject).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Request failed',
        }),
      );
      expect(resolve).not.toHaveBeenCalled();
    });

    it('should handle error object in error response', () => {
      const requestId = 'outgoing-req-3';
      const response: CLIControlResponse = {
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: requestId,
          error: { message: 'Detailed error', code: 500 },
        },
      };

      const resolve = vi.fn();
      const reject = vi.fn();
      const timeoutId = setTimeout(() => {}, 1000);

      (
        dispatcher as unknown as {
          registerOutgoingRequest: (
            id: string,
            controller: string,
            resolve: (r: ControlResponse) => void,
            reject: (e: Error) => void,
            timeoutId: NodeJS.Timeout,
          ) => void;
        }
      ).registerOutgoingRequest(
        requestId,
        'SystemController',
        resolve,
        reject,
        timeoutId,
      );

      dispatcher.handleControlResponse(response);

      expect(reject).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Detailed error',
        }),
      );
    });

    it('should handle response for non-existent pending request gracefully', () => {
      const response: CLIControlResponse = {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'non-existent',
          response: {},
        },
      };

      // Should not throw
      expect(() => dispatcher.handleControlResponse(response)).not.toThrow();
    });

    it('should handle response for non-existent request in debug mode', () => {
      const context = createMockContext(true);
      const consoleSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      const dispatcherWithDebug = new ControlDispatcher(context);
      const response: CLIControlResponse = {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'non-existent',
          response: {},
        },
      };

      dispatcherWithDebug.handleControlResponse(response);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          '[ControlDispatcher] No pending outgoing request for: non-existent',
        ),
      );

      consoleSpy.mockRestore();
    });
  });

  describe('sendControlRequest', () => {
    it('should delegate to system controller sendControlRequest', async () => {
      const payload: ControlRequestPayload = {
        subtype: 'initialize',
      } as CLIControlInitializeRequest;

      const expectedResponse: ControlResponse = {
        subtype: 'success',
        request_id: 'test-id',
        response: {},
      };

      vi.mocked(mockSystemController.sendControlRequest).mockResolvedValue(
        expectedResponse,
      );

      const result = await dispatcher.sendControlRequest(payload, 5000);

      expect(mockSystemController.sendControlRequest).toHaveBeenCalledWith(
        payload,
        5000,
      );
      expect(result).toBe(expectedResponse);
    });
  });

  describe('handleCancel', () => {
    it('should cancel specific incoming request', () => {
      const requestId = 'cancel-req-1';
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => {}, 1000);

      const abortSpy = vi.spyOn(abortController, 'abort');

      (
        dispatcher as unknown as {
          registerIncomingRequest: (
            id: string,
            controller: string,
            abortController: AbortController,
            timeoutId: NodeJS.Timeout,
          ) => void;
        }
      ).registerIncomingRequest(
        requestId,
        'SystemController',
        abortController,
        timeoutId,
      );

      dispatcher.handleCancel(requestId);

      expect(abortSpy).toHaveBeenCalled();
      expect(mockContext.streamJson.send).toHaveBeenCalledWith({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: requestId,
          error: 'Request cancelled',
        },
      });
    });

    it('should cancel all incoming requests when no requestId provided', () => {
      const requestId1 = 'cancel-req-2';
      const requestId2 = 'cancel-req-3';

      const abortController1 = new AbortController();
      const abortController2 = new AbortController();
      const timeoutId1 = setTimeout(() => {}, 1000);
      const timeoutId2 = setTimeout(() => {}, 1000);

      const abortSpy1 = vi.spyOn(abortController1, 'abort');
      const abortSpy2 = vi.spyOn(abortController2, 'abort');

      const register = (
        dispatcher as unknown as {
          registerIncomingRequest: (
            id: string,
            controller: string,
            abortController: AbortController,
            timeoutId: NodeJS.Timeout,
          ) => void;
        }
      ).registerIncomingRequest.bind(dispatcher);

      register(requestId1, 'SystemController', abortController1, timeoutId1);
      register(requestId2, 'SystemController', abortController2, timeoutId2);

      dispatcher.handleCancel();

      expect(abortSpy1).toHaveBeenCalled();
      expect(abortSpy2).toHaveBeenCalled();
      expect(mockContext.streamJson.send).toHaveBeenCalledTimes(2);
      expect(mockContext.streamJson.send).toHaveBeenCalledWith({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: requestId1,
          error: 'All requests cancelled',
        },
      });
      expect(mockContext.streamJson.send).toHaveBeenCalledWith({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: requestId2,
          error: 'All requests cancelled',
        },
      });
    });

    it('should handle cancel of non-existent request gracefully', () => {
      expect(() => dispatcher.handleCancel('non-existent')).not.toThrow();
    });

    it('should log cancellation in debug mode', () => {
      const context = createMockContext(true);
      const consoleSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      const dispatcherWithDebug = new ControlDispatcher(context);
      const requestId = 'cancel-req-debug';
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => {}, 1000);

      (
        dispatcherWithDebug as unknown as {
          registerIncomingRequest: (
            id: string,
            controller: string,
            abortController: AbortController,
            timeoutId: NodeJS.Timeout,
          ) => void;
        }
      ).registerIncomingRequest(
        requestId,
        'SystemController',
        abortController,
        timeoutId,
      );

      dispatcherWithDebug.handleCancel(requestId);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          '[ControlDispatcher] Cancelled incoming request: cancel-req-debug',
        ),
      );

      consoleSpy.mockRestore();
    });
  });

  describe('shutdown', () => {
    it('should cancel all pending incoming requests', () => {
      const requestId1 = 'shutdown-req-1';
      const requestId2 = 'shutdown-req-2';

      const abortController1 = new AbortController();
      const abortController2 = new AbortController();
      const timeoutId1 = setTimeout(() => {}, 1000);
      const timeoutId2 = setTimeout(() => {}, 1000);

      const abortSpy1 = vi.spyOn(abortController1, 'abort');
      const abortSpy2 = vi.spyOn(abortController2, 'abort');
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

      const register = (
        dispatcher as unknown as {
          registerIncomingRequest: (
            id: string,
            controller: string,
            abortController: AbortController,
            timeoutId: NodeJS.Timeout,
          ) => void;
        }
      ).registerIncomingRequest.bind(dispatcher);

      register(requestId1, 'SystemController', abortController1, timeoutId1);
      register(requestId2, 'SystemController', abortController2, timeoutId2);

      dispatcher.shutdown();

      expect(abortSpy1).toHaveBeenCalled();
      expect(abortSpy2).toHaveBeenCalled();
      expect(clearTimeoutSpy).toHaveBeenCalledWith(timeoutId1);
      expect(clearTimeoutSpy).toHaveBeenCalledWith(timeoutId2);
    });

    it('should reject all pending outgoing requests', () => {
      const requestId1 = 'outgoing-shutdown-1';
      const requestId2 = 'outgoing-shutdown-2';

      const reject1 = vi.fn();
      const reject2 = vi.fn();
      const timeoutId1 = setTimeout(() => {}, 1000);
      const timeoutId2 = setTimeout(() => {}, 1000);

      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

      const register = (
        dispatcher as unknown as {
          registerOutgoingRequest: (
            id: string,
            controller: string,
            resolve: (r: ControlResponse) => void,
            reject: (e: Error) => void,
            timeoutId: NodeJS.Timeout,
          ) => void;
        }
      ).registerOutgoingRequest.bind(dispatcher);

      register(requestId1, 'SystemController', vi.fn(), reject1, timeoutId1);
      register(requestId2, 'SystemController', vi.fn(), reject2, timeoutId2);

      dispatcher.shutdown();

      expect(reject1).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Dispatcher shutdown',
        }),
      );
      expect(reject2).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Dispatcher shutdown',
        }),
      );
      expect(clearTimeoutSpy).toHaveBeenCalledWith(timeoutId1);
      expect(clearTimeoutSpy).toHaveBeenCalledWith(timeoutId2);
    });

    it('should cleanup all controllers', () => {
      vi.mocked(mockSystemController.cleanup).mockImplementation(() => {});

      dispatcher.shutdown();

      expect(mockSystemController.cleanup).toHaveBeenCalled();
    });

    it('should log shutdown in debug mode', () => {
      const context = createMockContext(true);
      const consoleSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      const dispatcherWithDebug = new ControlDispatcher(context);

      dispatcherWithDebug.shutdown();

      expect(consoleSpy).toHaveBeenCalledWith(
        '[ControlDispatcher] Shutting down',
      );

      consoleSpy.mockRestore();
    });
  });

  describe('pending request registry', () => {
    describe('registerIncomingRequest', () => {
      it('should register incoming request', () => {
        const requestId = 'reg-incoming-1';
        const abortController = new AbortController();
        const timeoutId = setTimeout(() => {}, 1000);

        (
          dispatcher as unknown as {
            registerIncomingRequest: (
              id: string,
              controller: string,
              abortController: AbortController,
              timeoutId: NodeJS.Timeout,
            ) => void;
          }
        ).registerIncomingRequest(
          requestId,
          'SystemController',
          abortController,
          timeoutId,
        );

        // Verify it was registered by trying to cancel it
        dispatcher.handleCancel(requestId);
        expect(abortController.signal.aborted).toBe(true);
      });
    });

    describe('deregisterIncomingRequest', () => {
      it('should deregister incoming request', () => {
        const requestId = 'dereg-incoming-1';
        const abortController = new AbortController();
        const timeoutId = setTimeout(() => {}, 1000);

        const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

        (
          dispatcher as unknown as {
            registerIncomingRequest: (
              id: string,
              controller: string,
              abortController: AbortController,
              timeoutId: NodeJS.Timeout,
            ) => void;
            deregisterIncomingRequest: (id: string) => void;
          }
        ).registerIncomingRequest(
          requestId,
          'SystemController',
          abortController,
          timeoutId,
        );

        (
          dispatcher as unknown as {
            deregisterIncomingRequest: (id: string) => void;
          }
        ).deregisterIncomingRequest(requestId);

        // Verify it was deregistered - cancel should not find it
        const sendMock = vi.mocked(mockContext.streamJson.send);
        const sendCallCount = sendMock.mock.calls.length;
        dispatcher.handleCancel(requestId);
        // Should not send cancel response for non-existent request
        expect(sendMock.mock.calls.length).toBe(sendCallCount);
        expect(clearTimeoutSpy).toHaveBeenCalledWith(timeoutId);
      });

      it('should handle deregister of non-existent request gracefully', () => {
        expect(() => {
          (
            dispatcher as unknown as {
              deregisterIncomingRequest: (id: string) => void;
            }
          ).deregisterIncomingRequest('non-existent');
        }).not.toThrow();
      });
    });

    describe('registerOutgoingRequest', () => {
      it('should register outgoing request', () => {
        const requestId = 'reg-outgoing-1';
        const resolve = vi.fn();
        const reject = vi.fn();
        const timeoutId = setTimeout(() => {}, 1000);

        (
          dispatcher as unknown as {
            registerOutgoingRequest: (
              id: string,
              controller: string,
              resolve: (r: ControlResponse) => void,
              reject: (e: Error) => void,
              timeoutId: NodeJS.Timeout,
            ) => void;
          }
        ).registerOutgoingRequest(
          requestId,
          'SystemController',
          resolve,
          reject,
          timeoutId,
        );

        // Verify it was registered by handling a response
        const response: CLIControlResponse = {
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: requestId,
            response: {},
          },
        };

        dispatcher.handleControlResponse(response);
        expect(resolve).toHaveBeenCalled();
      });
    });

    describe('deregisterOutgoingRequest', () => {
      it('should deregister outgoing request', () => {
        const requestId = 'dereg-outgoing-1';
        const resolve = vi.fn();
        const reject = vi.fn();
        const timeoutId = setTimeout(() => {}, 1000);

        const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');

        (
          dispatcher as unknown as {
            registerOutgoingRequest: (
              id: string,
              controller: string,
              resolve: (r: ControlResponse) => void,
              reject: (e: Error) => void,
              timeoutId: NodeJS.Timeout,
            ) => void;
            deregisterOutgoingRequest: (id: string) => void;
          }
        ).registerOutgoingRequest(
          requestId,
          'SystemController',
          resolve,
          reject,
          timeoutId,
        );

        (
          dispatcher as unknown as {
            deregisterOutgoingRequest: (id: string) => void;
          }
        ).deregisterOutgoingRequest(requestId);

        // Verify it was deregistered - response should not find it
        const response: CLIControlResponse = {
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: requestId,
            response: {},
          },
        };

        dispatcher.handleControlResponse(response);
        expect(resolve).not.toHaveBeenCalled();
        expect(clearTimeoutSpy).toHaveBeenCalledWith(timeoutId);
      });

      it('should handle deregister of non-existent request gracefully', () => {
        expect(() => {
          (
            dispatcher as unknown as {
              deregisterOutgoingRequest: (id: string) => void;
            }
          ).deregisterOutgoingRequest('non-existent');
        }).not.toThrow();
      });
    });
  });
});
