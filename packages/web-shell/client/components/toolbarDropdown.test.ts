import { describe, expect, it } from 'vitest';
import {
  filterToolbarDropdownItems,
  getToolbarDropdownGeometry,
  getToolbarLabelVisibility,
  resolveToolbarModelLabel,
} from './toolbarDropdown';

const boundary = {
  left: 100,
  top: 80,
  right: 500,
  bottom: 680,
  width: 400,
  height: 600,
};

describe('toolbarDropdown', () => {
  it('filters by display label and stable model id', () => {
    const items = [
      { id: 'a', label: 'Qwen 3.5', searchText: 'qwen3.5-plus (oauth)' },
      { id: 'b', label: 'GLM 5.2', searchText: 'glm-5.2 (gateway)' },
      { id: 'c', label: 'Local model' },
    ];

    expect(filterToolbarDropdownItems(items, 'glm')).toEqual([items[1]]);
    expect(filterToolbarDropdownItems(items, 'oauth')).toEqual([items[0]]);
    expect(filterToolbarDropdownItems(items, 'local')).toEqual([items[2]]);
    expect(filterToolbarDropdownItems(items, '  ')).toEqual(items);
  });

  it('clamps the right edge when the menu fits in the WebShell boundary', () => {
    const geometry = getToolbarDropdownGeometry({
      anchor: {
        left: 450,
        top: 600,
        right: 478,
        bottom: 628,
        width: 28,
        height: 28,
      },
      boundary,
      viewportWidth: 800,
      viewportHeight: 800,
      preferredWidth: 360,
      maxHeight: 300,
    });

    expect(geometry.width).toBe(360);
    expect(geometry.left).toBe(132);
    expect(geometry.placement).toBe('above');
    expect(geometry.maxHeight).toBe(300);
  });

  it('clamps the left edge and width to the visible boundary', () => {
    const geometry = getToolbarDropdownGeometry({
      anchor: {
        left: 80,
        top: 600,
        right: 108,
        bottom: 628,
        width: 28,
        height: 28,
      },
      boundary,
      viewportWidth: 420,
      viewportHeight: 800,
      preferredWidth: 360,
    });

    expect(geometry.width).toBe(304);
    expect(geometry.left).toBe(108);
  });

  it('uses the lower side only when it has more usable height', () => {
    const geometry = getToolbarDropdownGeometry({
      anchor: {
        left: 160,
        top: 120,
        right: 188,
        bottom: 148,
        width: 28,
        height: 28,
      },
      boundary,
      viewportWidth: 800,
      viewportHeight: 800,
      preferredWidth: 300,
    });

    expect(geometry.placement).toBe('below');
    expect(geometry.top).toBe(152);
  });

  it('keeps the model label before the approval-mode label', () => {
    expect(
      getToolbarLabelVisibility({
        availableWidth: 144,
        modelLabelWidth: 80,
        modeLabelWidth: 64,
        modelLabelReady: true,
      }),
    ).toEqual({ showModelLabel: true, showModeLabel: true });
    expect(
      getToolbarLabelVisibility({
        availableWidth: 80,
        modelLabelWidth: 80,
        modeLabelWidth: 64,
        modelLabelReady: true,
      }),
    ).toEqual({ showModelLabel: true, showModeLabel: false });
    expect(
      getToolbarLabelVisibility({
        availableWidth: 79,
        modelLabelWidth: 80,
        modeLabelWidth: 64,
        modelLabelReady: true,
      }),
    ).toEqual({ showModelLabel: false, showModeLabel: false });
  });

  it('keeps both labels hidden while the initial model is pending', () => {
    const pending = resolveToolbarModelLabel({
      currentModelLabel: '',
      lastConfirmedModelLabel: '',
    });

    expect(pending.modelLabelReady).toBe(false);
    expect(
      getToolbarLabelVisibility({
        availableWidth: 300,
        modelLabelWidth: 0,
        modeLabelWidth: 64,
        modelLabelReady: pending.modelLabelReady,
      }),
    ).toEqual({ showModelLabel: false, showModeLabel: false });
  });

  it('shows the approval-mode label when it is the only visible action', () => {
    expect(
      getToolbarLabelVisibility({
        availableWidth: 64,
        modelLabelWidth: 0,
        modeLabelWidth: 64,
        modelLabelReady: false,
        modelActionVisible: false,
        modeActionVisible: true,
      }),
    ).toEqual({ showModelLabel: false, showModeLabel: true });
  });

  it('keeps the confirmed model through a transient empty update', () => {
    const confirmed = resolveToolbarModelLabel({
      currentModelLabel: 'Qwen 3.5 Plus',
      lastConfirmedModelLabel: '',
    });
    const transientEmpty = resolveToolbarModelLabel({
      currentModelLabel: '',
      lastConfirmedModelLabel: confirmed.nextConfirmedModelLabel,
    });

    expect(transientEmpty.modelLabel).toBe('Qwen 3.5 Plus');
    expect(
      getToolbarLabelVisibility({
        availableWidth: 112,
        modelLabelWidth: 112,
        modeLabelWidth: 64,
        modelLabelReady: transientEmpty.modelLabelReady,
      }),
    ).toEqual({ showModelLabel: true, showModeLabel: false });
  });

  it('uses an arriving replacement for the next measured layout', () => {
    const replacement = resolveToolbarModelLabel({
      currentModelLabel: 'GLM 5.2',
      lastConfirmedModelLabel: 'Qwen 3.5 Plus',
    });

    expect(replacement.modelLabel).toBe('GLM 5.2');
    expect(
      getToolbarLabelVisibility({
        availableWidth: 128,
        modelLabelWidth: 80,
        modeLabelWidth: 64,
        modelLabelReady: replacement.modelLabelReady,
      }),
    ).toEqual({ showModelLabel: true, showModeLabel: false });
  });
});
