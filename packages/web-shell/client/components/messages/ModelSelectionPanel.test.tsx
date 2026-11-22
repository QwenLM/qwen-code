// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  ModelSelectionPanel,
  formatPricePerMillion,
  formatContextTokens,
  resetDeepinfraCacheForTest,
} from './ModelSelectionPanel';
import { I18nProvider } from '../../i18n';
import type { DaemonAuthProviderDescriptor } from '@qwen-code/web-shell/daemon-react-sdk';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('ModelSelectionPanel unit tests', () => {
  describe('formatPricePerMillion', () => {
    it('formats cents per token into dollars per million tokens', () => {
      // 0.000032 cents/token -> $0.32/Mt
      expect(formatPricePerMillion(0.000032)).toBe('$0.32/Mt');
      // 0.00032 cents/token -> $3.20/Mt
      expect(formatPricePerMillion(0.00032)).toBe('$3.20/Mt');
      // 5e-7 cents/token -> $0.0050/Mt
      expect(formatPricePerMillion(0.0000005)).toBe('$0.0050/Mt');
      // Free and null
      expect(formatPricePerMillion(0)).toBe('Free');
      expect(formatPricePerMillion(null)).toBe('—');
      expect(formatPricePerMillion(undefined)).toBe('—');
    });
  });

  describe('formatContextTokens', () => {
    it('formats token count into readable format', () => {
      expect(formatContextTokens(262144)).toBe('256k');
      expect(formatContextTokens(131072)).toBe('128k');
      expect(formatContextTokens(32768)).toBe('32k');
      expect(formatContextTokens(1048576)).toBe('1024k');
      expect(formatContextTokens(1000000)).toBe('1M');
      expect(formatContextTokens(null)).toBe('—');
    });
  });

  describe('rendering and user interactions', () => {
    let container: HTMLDivElement;
    let root: Root;

    const mockProvider: DaemonAuthProviderDescriptor = {
      id: 'test-provider',
      label: 'Test Provider',
      description: 'Testing provider',
      protocol: 'openai',
      steps: ['models'],
      models: [
        {
          id: 'model-a',
          contextWindowSize: 128000,
          description: 'First model',
        },
        {
          id: 'model-b',
          contextWindowSize: 32000,
          description: 'Second model',
        },
        {
          id: 'qwen-model',
          contextWindowSize: 262144,
          description: 'Qwen model',
        },
      ],
    };

    beforeEach(() => {
      resetDeepinfraCacheForTest();
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
    });

    it('renders models from provider and allows selection', async () => {
      const handleChange = vi.fn();

      await act(async () => {
        root.render(
          <I18nProvider language="en">
            <ModelSelectionPanel
              provider={mockProvider}
              value="model-a"
              onChange={handleChange}
            />
          </I18nProvider>,
        );
      });

      expect(container.textContent).toContain('model-a');
      expect(container.textContent).toContain('model-b');
      expect(container.textContent).toContain('qwen-model');
      expect(container.textContent).toContain('1 model selected');

      // Click on model-b row to toggle selection
      const rows = container.querySelectorAll('tbody tr');
      expect(rows.length).toBe(3);

      await act(async () => {
        (rows[1] as HTMLElement).click();
      });

      expect(handleChange).toHaveBeenCalledWith('model-a, model-b');
    });

    it('filters models by search query', async () => {
      const handleChange = vi.fn();

      await act(async () => {
        root.render(
          <I18nProvider language="en">
            <ModelSelectionPanel
              provider={mockProvider}
              value=""
              onChange={handleChange}
            />
          </I18nProvider>,
        );
      });

      const searchInput = container.querySelector(
        'input[placeholder="Search model name..."]',
      ) as HTMLInputElement;
      expect(searchInput).not.toBeNull();

      await act(async () => {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )!.set!.call(searchInput, 'qwen');
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      });

      const visibleRows = container.querySelectorAll('tbody tr');
      expect(visibleRows.length).toBe(1);
      expect(visibleRows[0]?.textContent).toContain('qwen-model');
    });

    it('fetches and displays rich DeepInfra models when provider is deepinfra', async () => {
      const deepinfraProvider: DaemonAuthProviderDescriptor = {
        id: 'deepinfra',
        label: 'DeepInfra',
        description: 'DeepInfra provider',
        protocol: 'openai',
        baseUrl: 'https://api.deepinfra.com/v1/openai',
        steps: ['models'],
      };

      const mockDeepInfraModels = [
        {
          model_name: 'Qwen/Qwen3.6-27B',
          type: 'text-generation',
          max_tokens: 262144,
          quantization: 'fp8',
          tags: ['openai', 'flex', 'priority', 'featured'],
          pricing: {
            cents_per_input_token: 0.000032,
            cents_per_output_token: 0.00032,
            discount: 0.25,
          },
        },
        {
          model_name: 'deepseek-ai/DeepSeek-V3',
          type: 'text-generation',
          max_tokens: 128000,
          quantization: null,
          tags: ['openai'],
          pricing: {
            cents_per_input_token: 0.000014,
            cents_per_output_token: 0.000028,
          },
        },
        {
          model_name: 'anthropic/claude-3-5-sonnet',
          type: 'text-generation',
          max_tokens: 200000,
          quantization: null,
          tags: ['openai'],
        },
      ];

      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async (input) => {
          const url = String(input);
          if (url === '/workspace/auth/deepinfra-models') {
            return {
              ok: true,
              json: async () => mockDeepInfraModels,
            } as Response;
          }
          return {
            ok: false,
            status: 404,
          } as Response;
        });

      await act(async () => {
        root.render(
          <I18nProvider language="en">
            <ModelSelectionPanel
              provider={deepinfraProvider}
              value=""
              onChange={vi.fn()}
              defaultModelIds="default-model-1"
            />
          </I18nProvider>,
        );
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        '/workspace/auth/deepinfra-models',
        expect.any(Object),
      );

      // Verify that DeepInfra models are rendered with all details
      expect(container.textContent).toContain('Qwen/Qwen3.6-27B');
      expect(container.textContent).toContain('deepseek-ai/DeepSeek-V3');
      expect(container.textContent).not.toContain(
        'anthropic/claude-3-5-sonnet',
      );
      expect(container.textContent).toContain('fp8');
      expect(container.textContent).toContain('$0.32/Mt');
      expect(container.textContent).toContain('$3.20/Mt');
      expect(container.textContent).toContain('$0.14/Mt');
      expect(container.textContent).toContain('$0.28/Mt');

      // Verify icons: Featured icon (Sparkles), Flex icon (Clock), Priority icon (Zap), and Discount icon (Tag)
      const featuredIcon = container.querySelector(
        'svg[aria-label="Featured model"]',
      );
      expect(featuredIcon).not.toBeNull();
      const flexIcon = container.querySelector('svg[aria-label="Flex tier"]');
      expect(flexIcon).not.toBeNull();
      const priorityIcon = container.querySelector(
        'svg[aria-label="Priority tier"]',
      );
      expect(priorityIcon).not.toBeNull();
      const discountIcon = container.querySelector(
        'svg[aria-label="Discount available"]',
      );
      expect(discountIcon).not.toBeNull();

      // Verify prompt text moved to manual input section at bottom
      const manualSection = container.querySelector(
        '[class*="manualInputSection"]',
      );
      expect(manualSection).not.toBeNull();
      expect(manualSection?.textContent).toContain(
        'Enter model IDs separated by commas',
      );

      fetchSpy.mockRestore();
    });

    it('sorts table asc/desc by name, context, quant, and pricing', async () => {
      const handleChange = vi.fn();

      await act(async () => {
        root.render(
          <I18nProvider language="en">
            <ModelSelectionPanel
              provider={mockProvider}
              value=""
              onChange={handleChange}
            />
          </I18nProvider>,
        );
      });

      // Default sort is by name ascending: model-a, model-b, qwen-model
      let rows = container.querySelectorAll('tbody tr');
      expect(rows[0]?.textContent).toContain('model-a');
      expect(rows[1]?.textContent).toContain('model-b');
      expect(rows[2]?.textContent).toContain('qwen-model');

      // Click Model header to toggle descending
      const modelHeaderBtn = container.querySelectorAll('th button')[0];
      await act(async () => {
        (modelHeaderBtn as HTMLButtonElement).click();
      });

      rows = container.querySelectorAll('tbody tr');
      expect(rows[0]?.textContent).toContain('qwen-model');
      expect(rows[1]?.textContent).toContain('model-b');
      expect(rows[2]?.textContent).toContain('model-a');

      // Click Context header to sort by context ascending
      const contextHeaderBtn = container.querySelectorAll('th button')[1];
      await act(async () => {
        (contextHeaderBtn as HTMLButtonElement).click();
      });

      rows = container.querySelectorAll('tbody tr');
      // 32k (model-b), 128k (model-a), 256k (qwen-model)
      expect(rows[0]?.textContent).toContain('model-b');
      expect(rows[1]?.textContent).toContain('model-a');
      expect(rows[2]?.textContent).toContain('qwen-model');

      // Click Context header again for descending
      await act(async () => {
        (contextHeaderBtn as HTMLButtonElement).click();
      });

      rows = container.querySelectorAll('tbody tr');
      expect(rows[0]?.textContent).toContain('qwen-model');
      expect(rows[1]?.textContent).toContain('model-a');
      expect(rows[2]?.textContent).toContain('model-b');
    });

    it('sorts independently by In pricing and Out pricing (asc and desc)', async () => {
      const deepinfraProvider: DaemonAuthProviderDescriptor = {
        id: 'deepinfra',
        label: 'DeepInfra',
        description: 'DeepInfra provider',
        protocol: 'openai',
        baseUrl: 'https://api.deepinfra.com/v1/openai',
        steps: ['models'],
      };

      const mockDeepInfraModels = [
        {
          model_name: 'model-high-in-low-out',
          type: 'text-generation',
          max_tokens: 128000,
          quantization: 'fp8',
          tags: ['openai'],
          pricing: {
            cents_per_input_token: 0.0005, // $5.00/Mt in
            cents_per_output_token: 0.0001, // $1.00/Mt out
          },
        },
        {
          model_name: 'model-low-in-high-out',
          type: 'text-generation',
          max_tokens: 128000,
          quantization: 'fp8',
          tags: ['openai'],
          pricing: {
            cents_per_input_token: 0.0001, // $1.00/Mt in
            cents_per_output_token: 0.0009, // $9.00/Mt out
          },
        },
      ];

      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async (input) => {
          if (String(input).includes('deepinfra')) {
            return {
              ok: true,
              json: async () => mockDeepInfraModels,
            } as Response;
          }
          return { ok: false, status: 404 } as Response;
        });

      await act(async () => {
        root.render(
          <I18nProvider language="en">
            <ModelSelectionPanel
              provider={deepinfraProvider}
              value=""
              onChange={vi.fn()}
            />
          </I18nProvider>,
        );
      });

      // th buttons: Model (0), Context (1), Quant (2), In ($/Mt) (3), Out ($/Mt) (4)
      const inHeaderBtn = container.querySelectorAll('th button')[3];
      const outHeaderBtn = container.querySelectorAll('th button')[4];

      // 1. Sort by In ($/Mt) ascending
      await act(async () => {
        (inHeaderBtn as HTMLButtonElement).click();
      });

      let rows = container.querySelectorAll('tbody tr');
      // model-low-in-high-out ($1.00/Mt in) before model-high-in-low-out ($5.00/Mt in)
      expect(rows[0]?.textContent).toContain('model-low-in-high-out');
      expect(rows[1]?.textContent).toContain('model-high-in-low-out');

      // Sort by In ($/Mt) descending
      await act(async () => {
        (inHeaderBtn as HTMLButtonElement).click();
      });

      rows = container.querySelectorAll('tbody tr');
      expect(rows[0]?.textContent).toContain('model-high-in-low-out');
      expect(rows[1]?.textContent).toContain('model-low-in-high-out');

      // 2. Sort by Out ($/Mt) ascending
      await act(async () => {
        (outHeaderBtn as HTMLButtonElement).click();
      });

      rows = container.querySelectorAll('tbody tr');
      // model-high-in-low-out ($1.00/Mt out) before model-low-in-high-out ($9.00/Mt out)
      expect(rows[0]?.textContent).toContain('model-high-in-low-out');
      expect(rows[1]?.textContent).toContain('model-low-in-high-out');

      // Sort by Out ($/Mt) descending
      await act(async () => {
        (outHeaderBtn as HTMLButtonElement).click();
      });

      rows = container.querySelectorAll('tbody tr');
      expect(rows[0]?.textContent).toContain('model-low-in-high-out');
      expect(rows[1]?.textContent).toContain('model-high-in-low-out');

      fetchSpy.mockRestore();
    });

    it('renders and filters by Featured, Discount, Priority, and Flex buttons with icons', async () => {
      const deepinfraProvider: DaemonAuthProviderDescriptor = {
        id: 'deepinfra',
        label: 'DeepInfra',
        description: 'DeepInfra provider',
        protocol: 'openai',
        baseUrl: 'https://api.deepinfra.com/v1/openai',
        steps: ['models'],
      };

      const mockModels = [
        {
          model_name: 'model-featured',
          type: 'text-generation',
          max_tokens: 128000,
          quantization: 'fp8',
          tags: ['openai', 'featured'],
          pricing: null,
        },
        {
          model_name: 'model-discounted',
          type: 'text-generation',
          max_tokens: 128000,
          quantization: 'fp8',
          tags: ['openai'],
          pricing: {
            cents_per_input_token: 0.0001,
            cents_per_output_token: 0.0001,
            discount: 0.2,
          },
        },
        {
          model_name: 'model-priority',
          type: 'text-generation',
          max_tokens: 128000,
          quantization: 'fp8',
          tags: ['openai', 'priority'],
          pricing: null,
        },
        {
          model_name: 'model-flex',
          type: 'text-generation',
          max_tokens: 128000,
          quantization: 'fp8',
          tags: ['openai', 'flex'],
          pricing: null,
        },
      ];

      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async (input) => {
          if (String(input).includes('deepinfra')) {
            return {
              ok: true,
              json: async () => mockModels,
            } as Response;
          }
          return { ok: false, status: 404 } as Response;
        });

      await act(async () => {
        root.render(
          <I18nProvider language="en">
            <ModelSelectionPanel
              provider={deepinfraProvider}
              value=""
              onChange={vi.fn()}
            />
          </I18nProvider>,
        );
      });

      const buttons = Array.from(container.querySelectorAll('button'));
      const featuredBtn = buttons.find((b) =>
        b.textContent?.includes('Featured'),
      );
      const discountBtn = buttons.find((b) =>
        b.textContent?.includes('Discount'),
      );
      const priorityBtn = buttons.find((b) =>
        b.textContent?.includes('Priority'),
      );
      const flexBtn = buttons.find((b) => b.textContent?.includes('Flex'));

      expect(featuredBtn).toBeDefined();
      expect(discountBtn).toBeDefined();
      expect(priorityBtn).toBeDefined();
      expect(flexBtn).toBeDefined();

      // Ensure each button contains its SVG icon
      expect(featuredBtn?.querySelector('svg')).not.toBeNull();
      expect(discountBtn?.querySelector('svg')).not.toBeNull();
      expect(priorityBtn?.querySelector('svg')).not.toBeNull();
      expect(flexBtn?.querySelector('svg')).not.toBeNull();

      // Test Featured filter
      await act(async () => {
        featuredBtn?.click();
      });
      let rows = container.querySelectorAll('tbody tr');
      expect(rows.length).toBe(1);
      expect(rows[0]?.textContent).toContain('model-featured');

      // Untoggle Featured
      await act(async () => {
        featuredBtn?.click();
      });

      // Test Discount filter
      await act(async () => {
        discountBtn?.click();
      });
      rows = container.querySelectorAll('tbody tr');
      expect(rows.length).toBe(1);
      expect(rows[0]?.textContent).toContain('model-discounted');

      // Untoggle Discount
      await act(async () => {
        discountBtn?.click();
      });

      // Test Priority filter
      await act(async () => {
        priorityBtn?.click();
      });
      rows = container.querySelectorAll('tbody tr');
      expect(rows.length).toBe(1);
      expect(rows[0]?.textContent).toContain('model-priority');

      // Untoggle Priority
      await act(async () => {
        priorityBtn?.click();
      });

      // Test Flex filter
      await act(async () => {
        flexBtn?.click();
      });
      rows = container.querySelectorAll('tbody tr');
      expect(rows.length).toBe(1);
      expect(rows[0]?.textContent).toContain('model-flex');

      fetchSpy.mockRestore();
    });

    it('falls back to direct API fetch if daemon proxy endpoint fails', async () => {
      const deepinfraProvider: DaemonAuthProviderDescriptor = {
        id: 'deepinfra',
        label: 'DeepInfra',
        description: 'DeepInfra provider',
        protocol: 'openai',
        baseUrl: 'https://api.deepinfra.com/v1/openai',
        steps: ['models'],
      };

      const mockDeepInfraModels = [
        {
          model_name: 'fallback-model',
          type: 'text-generation',
          max_tokens: 65536,
          quantization: 'int4',
          tags: ['openai'],
          pricing: {
            cents_per_input_token: 0.00001,
            cents_per_output_token: 0.00002,
          },
        },
      ];

      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async (input) => {
          const url = String(input);
          if (url === '/workspace/auth/deepinfra-models') {
            return {
              ok: false,
              status: 502,
            } as Response;
          }
          if (url === 'https://api.deepinfra.com/models/list') {
            return {
              ok: true,
              json: async () => mockDeepInfraModels,
            } as Response;
          }
          return {
            ok: false,
            status: 404,
          } as Response;
        });

      await act(async () => {
        root.render(
          <I18nProvider language="en">
            <ModelSelectionPanel
              provider={deepinfraProvider}
              value=""
              onChange={vi.fn()}
            />
          </I18nProvider>,
        );
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.deepinfra.com/models/list',
        expect.any(Object),
      );
      expect(container.textContent).toContain('fallback-model');
      expect(container.textContent).toContain('int4');

      fetchSpy.mockRestore();
    });

    it('sorts table asc and desc when clicking Quant header', async () => {
      const deepinfraProvider: DaemonAuthProviderDescriptor = {
        id: 'deepinfra',
        label: 'DeepInfra',
        description: 'DeepInfra provider',
        protocol: 'openai',
        baseUrl: 'https://api.deepinfra.com/v1/openai',
        steps: ['models'],
      };

      const mockModels = [
        {
          model_name: 'model-fp8',
          type: 'text-generation',
          max_tokens: 32768,
          quantization: 'fp8',
        },
        {
          model_name: 'model-bf16',
          type: 'text-generation',
          max_tokens: 32768,
          quantization: 'bf16',
        },
        {
          model_name: 'model-fp4',
          type: 'text-generation',
          max_tokens: 32768,
          quantization: 'fp4',
        },
      ];

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => mockModels,
      } as Response);

      await act(async () => {
        root.render(
          <I18nProvider language="en">
            <ModelSelectionPanel
              provider={deepinfraProvider}
              value=""
              onChange={vi.fn()}
            />
          </I18nProvider>,
        );
      });

      // Quant header is the 3rd sortable header (index 2: Model=0, Context=1, Quant=2)
      const quantHeaderBtn = container.querySelectorAll('th button')[2];
      expect(quantHeaderBtn?.textContent).toContain('Quant');

      // Click Quant header for ascending: bf16, fp4, fp8
      await act(async () => {
        (quantHeaderBtn as HTMLButtonElement).click();
      });

      let rows = container.querySelectorAll('tbody tr');
      expect(rows[0]?.textContent).toContain('model-bf16');
      expect(rows[1]?.textContent).toContain('model-fp4');
      expect(rows[2]?.textContent).toContain('model-fp8');

      // Click Quant header again for descending: fp8, fp4, bf16
      await act(async () => {
        (quantHeaderBtn as HTMLButtonElement).click();
      });

      rows = container.querySelectorAll('tbody tr');
      expect(rows[0]?.textContent).toContain('model-fp8');
      expect(rows[1]?.textContent).toContain('model-fp4');
      expect(rows[2]?.textContent).toContain('model-bf16');

      fetchSpy.mockRestore();
    });

    it('routes daemon proxy fetch to daemonBaseUrl when provided', async () => {
      const deepinfraProvider: DaemonAuthProviderDescriptor = {
        id: 'deepinfra',
        label: 'DeepInfra',
        description: 'DeepInfra provider',
        protocol: 'openai',
        baseUrl: 'https://api.deepinfra.com/v1/openai',
        steps: ['models'],
      };

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => [
          {
            model_name: 'daemon-model',
            type: 'text-generation',
            max_tokens: 32768,
          },
        ],
      } as Response);

      await act(async () => {
        root.render(
          <I18nProvider language="en">
            <ModelSelectionPanel
              provider={deepinfraProvider}
              daemonBaseUrl="https://daemon.example.org:9000"
              value=""
              onChange={vi.fn()}
            />
          </I18nProvider>,
        );
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://daemon.example.org:9000/workspace/auth/deepinfra-models',
        expect.any(Object),
      );
      expect(container.textContent).toContain('daemon-model');

      fetchSpy.mockRestore();
    });

    it('shows error state with retry button when upstream fetch fails', async () => {
      const deepinfraProvider: DaemonAuthProviderDescriptor = {
        id: 'deepinfra',
        label: 'DeepInfra',
        description: 'DeepInfra provider',
        protocol: 'openai',
        baseUrl: 'https://api.deepinfra.com/v1/openai',
        steps: ['models'],
      };

      let attempt = 0;
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async () => {
          attempt++;
          if (attempt <= 2) {
            return { ok: false, status: 500 } as Response;
          }
          return {
            ok: true,
            json: async () => [
              {
                model_name: 'recovered-model',
                type: 'text-generation',
                max_tokens: 32768,
              },
            ],
          } as Response;
        });

      await act(async () => {
        root.render(
          <I18nProvider language="en">
            <ModelSelectionPanel
              provider={deepinfraProvider}
              value=""
              onChange={vi.fn()}
            />
          </I18nProvider>,
        );
      });

      expect(container.textContent).toContain('Failed to load models catalog');
      const retryBtn = container.querySelector(
        '[class*="retryButton"]',
      ) as HTMLButtonElement | null;
      expect(retryBtn).not.toBeNull();

      // Click retry
      await act(async () => {
        retryBtn?.click();
      });

      expect(container.textContent).toContain('recovered-model');
      expect(container.textContent).not.toContain(
        'Failed to load models catalog',
      );

      fetchSpy.mockRestore();
    });

    it('toggles aria-pressed on filter buttons', async () => {
      const deepinfraProvider: DaemonAuthProviderDescriptor = {
        id: 'deepinfra',
        label: 'DeepInfra',
        description: 'DeepInfra provider',
        protocol: 'openai',
        baseUrl: 'https://api.deepinfra.com/v1/openai',
        steps: ['models'],
      };

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => [],
      } as Response);

      await act(async () => {
        root.render(
          <I18nProvider language="en">
            <ModelSelectionPanel
              provider={deepinfraProvider}
              value=""
              onChange={vi.fn()}
            />
          </I18nProvider>,
        );
      });

      const buttons = Array.from(
        container.querySelectorAll('button[class*="filterButton"]'),
      ) as HTMLButtonElement[];
      const featuredBtn = buttons.find((b) =>
        b.textContent?.includes('Featured'),
      )!;

      expect(featuredBtn.getAttribute('aria-pressed')).toBe('false');

      await act(async () => {
        featuredBtn.click();
      });
      expect(featuredBtn.getAttribute('aria-pressed')).toBe('true');

      await act(async () => {
        featuredBtn.click();
      });
      expect(featuredBtn.getAttribute('aria-pressed')).toBe('false');

      fetchSpy.mockRestore();
    });

    it('handles fractional discounts and ignores expired discounts', async () => {
      const deepinfraProvider: DaemonAuthProviderDescriptor = {
        id: 'deepinfra',
        label: 'DeepInfra',
        description: 'DeepInfra provider',
        protocol: 'openai',
        baseUrl: 'https://api.deepinfra.com/v1/openai',
        steps: ['models'],
      };

      const futureDate = new Date(Date.now() + 86400000).toISOString();
      const pastDate = new Date(Date.now() - 86400000).toISOString();

      const mockModels = [
        {
          model_name: 'active-discount-model',
          type: 'text-generation',
          max_tokens: 32768,
          pricing: {
            discount: 0.375,
            discount_ends_at: futureDate,
          },
        },
        {
          model_name: 'expired-discount-model',
          type: 'text-generation',
          max_tokens: 32768,
          pricing: {
            discount: 0.5,
            discount_ends_at: pastDate,
          },
        },
      ];

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => mockModels,
      } as Response);

      await act(async () => {
        root.render(
          <I18nProvider language="en">
            <ModelSelectionPanel
              provider={deepinfraProvider}
              value=""
              onChange={vi.fn()}
            />
          </I18nProvider>,
        );
      });

      // Active model has discount icon with 37.5% off
      const activeRow = Array.from(container.querySelectorAll('tbody tr')).find(
        (r) => r.textContent?.includes('active-discount-model'),
      );
      expect(activeRow).toBeDefined();
      const discountTag = activeRow?.querySelector(
        'svg[aria-label="Discount available"]',
      );
      expect(discountTag).not.toBeNull();
      expect(discountTag?.parentElement?.getAttribute('title')).toBe(
        'Discounted (37.5% off)',
      );

      // Expired model does NOT have discount icon
      const expiredRow = Array.from(
        container.querySelectorAll('tbody tr'),
      ).find((r) => r.textContent?.includes('expired-discount-model'));
      expect(expiredRow).toBeDefined();
      expect(
        expiredRow?.querySelector('svg[aria-label="Discount available"]'),
      ).toBeNull();

      fetchSpy.mockRestore();
    });

    it('renders native button with aria-label for chip removal', async () => {
      const handleChange = vi.fn();

      await act(async () => {
        root.render(
          <I18nProvider language="en">
            <ModelSelectionPanel
              provider={mockProvider}
              value="model-a"
              onChange={handleChange}
            />
          </I18nProvider>,
        );
      });

      const removeBtn = container.querySelector(
        'button[aria-label="Remove model-a"]',
      ) as HTMLButtonElement | null;
      expect(removeBtn).not.toBeNull();

      await act(async () => {
        removeBtn?.click();
      });

      expect(handleChange).toHaveBeenCalledWith('');
    });

    it('notifies onModelSpecsChange with contextWindowSize for selected models', async () => {
      const handleModelSpecsChange = vi.fn();

      await act(async () => {
        root.render(
          <I18nProvider language="en">
            <ModelSelectionPanel
              provider={mockProvider}
              value="model-a, model-b"
              onChange={vi.fn()}
              onModelSpecsChange={handleModelSpecsChange}
            />
          </I18nProvider>,
        );
      });

      expect(handleModelSpecsChange).toHaveBeenCalledWith([
        { id: 'model-a', contextWindowSize: 128000 },
        { id: 'model-b', contextWindowSize: 32000 },
      ]);
    });
  });
});
