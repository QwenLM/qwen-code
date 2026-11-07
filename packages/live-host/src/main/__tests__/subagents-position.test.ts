import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  fitSubagentsBounds,
  subagentsSidecarBounds,
} from '../subagents-position.ts';
import { OVERLAY_GEOMETRY } from '../../shared/overlay-geometry.ts';
import { overlayPosition } from '../overlay-position.ts';

const primary = { x: 0, y: 30, width: 2048, height: 1028 };
const right = { x: 2048, y: 33, width: 1728, height: 1084 };
const sizes = [
  { width: 132, height: 62 },
  { width: 330, height: 430 },
  { width: 330, height: 430 },
];
describe('Subagents floating panel geometry', () => {
  it('keeps expanded panels clear of the complete dock including its wider status bar', () => {
    const area = { x: 0, y: 33, width: 1728, height: 990 };
    const visible = OVERLAY_GEOMETRY.bounds.orb;
    const origin = overlayPosition(area, visible);
    const anchor = {
      x: origin.x + visible.x,
      y: origin.y + visible.y,
      width: visible.width,
      height: visible.height,
    };
    for (const size of sizes) {
      const result = subagentsSidecarBounds(anchor, size, area);
      assert(result.bounds.x + result.bounds.width + 12 <= anchor.x);
      assert(result.bounds.y >= area.y);
      assert(result.bounds.y + result.bounds.height <= area.y + area.height);
    }
  });

  it('changes an undersized summary side on expansion instead of clamping into the dock', () => {
    const area = { x: 0, y: 0, width: 1000, height: 800 };
    const anchor = { x: 200, y: 400, width: 264, height: 344 };
    const summary = subagentsSidecarBounds(anchor, sizes[0]!, area);
    assert.equal(summary.side, 'left');
    const expanded = subagentsSidecarBounds(
      anchor,
      sizes[1]!,
      area,
      summary.side,
    );
    assert.equal(expanded.side, 'right');
    assert(expanded.bounds.x >= anchor.x + anchor.width + 12);
  });

  it('fits summary, list and detail at every edge without modifying the orb anchor', () => {
    for (const area of [
      primary,
      right,
      { x: -1920, y: -200, width: 1920, height: 1080 },
    ]) {
      for (const point of [
        { x: area.x, y: area.y },
        { x: area.x + area.width - 156, y: area.y },
        { x: area.x, y: area.y + area.height - 156 },
        { x: area.x + area.width - 156, y: area.y + area.height - 156 },
      ]) {
        const anchor = { ...point, width: 156, height: 156 };
        const before = { ...anchor };
        for (const size of sizes) {
          const { bounds } = subagentsSidecarBounds(anchor, size, area);
          assert(bounds.x >= area.x && bounds.y >= area.y);
          assert(bounds.x + bounds.width <= area.x + area.width);
          assert(bounds.y + bounds.height <= area.y + area.height);
          assert.deepEqual(anchor, before);
        }
      }
    }
  });
  it('selects the inward side and retains it while expanding or receiving updates', () => {
    const anchor = { x: 1810, y: 850, width: 156, height: 156 };
    const summary = subagentsSidecarBounds(anchor, sizes[0]!, primary);
    assert.equal(summary.side, 'left');
    const list = subagentsSidecarBounds(
      anchor,
      sizes[1]!,
      primary,
      summary.side,
    );
    assert.equal(list.side, 'left');
    assert(list.bounds.x + list.bounds.width < anchor.x);
    assert.deepEqual(
      subagentsSidecarBounds(anchor, sizes[1]!, primary, list.side),
      list,
    );
    assert.equal(
      subagentsSidecarBounds(
        { x: 8, y: 200, width: 156, height: 156 },
        sizes[0]!,
        primary,
      ).side,
      'right',
    );
  });
  it('shrinks task windows for small work areas and clamps removed-display preferences', () => {
    const tiny = { x: 100, y: 50, width: 300, height: 220 };
    const fitted = fitSubagentsBounds({ x: 3000, y: -900 }, sizes[2]!, tiny);
    assert.deepEqual(fitted, { x: 108, y: 58, width: 284, height: 204 });
    const restored = fitSubagentsBounds(
      { x: 2500, y: 600 },
      sizes[2]!,
      primary,
    );
    assert(restored.x + restored.width <= 2048);
  });
});
