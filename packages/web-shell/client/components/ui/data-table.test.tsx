// @vitest-environment jsdom
import { useMemo, type ReactNode } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import {
  type ColumnDef,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { describe, expect, it } from 'vitest';

import { DataTable, type DataTableColumnMeta } from './data-table';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

interface Item {
  sized: string;
  automatic: string;
}

function TableHarness() {
  const columns = useMemo<ColumnDef<Item>[]>(
    () => [
      {
        accessorKey: 'sized',
        header: 'Sized',
        meta: { width: 200 } satisfies DataTableColumnMeta,
      },
      { accessorKey: 'automatic', header: 'Automatic' },
    ],
    [],
  );
  const table = useReactTable({
    data: [{ sized: 'Sized', automatic: 'Automatic' }],
    columns,
    getCoreRowModel: getCoreRowModel(),
  });
  return <DataTable table={table} />;
}

function FixedTableHarness() {
  const columns = useMemo<ColumnDef<Item>[]>(
    () => [
      {
        accessorKey: 'sized',
        header: 'First',
        meta: {
          fixed: 'left',
          width: 100,
          fluidWeight: 1,
        } satisfies DataTableColumnMeta,
      },
      {
        accessorKey: 'automatic',
        header: 'Second',
        meta: {
          fixed: 'left',
          fixedWidth: true,
          width: 100,
        } satisfies DataTableColumnMeta,
      },
      {
        id: 'remaining',
        header: 'Remaining',
        cell: () => 'Remaining',
        meta: { width: 100, fluidWeight: 1 } satisfies DataTableColumnMeta,
      },
    ],
    [],
  );
  const table = useReactTable({
    data: [{ sized: 'First', automatic: 'Second' }],
    columns,
    getCoreRowModel: getCoreRowModel(),
  });
  return <DataTable table={table} />;
}

function renderAtWidth(element: ReactNode, width: number) {
  let resize: ResizeObserverCallback = () => undefined;
  const originalResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) {
      resize = callback;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(element));
  const scroller = container.querySelector(
    '[data-slot="table-container"]',
  ) as HTMLElement;
  Object.defineProperties(scroller, {
    clientWidth: { configurable: true, value: width },
    scrollWidth: { configurable: true, value: width },
  });
  act(() => resize([], {} as ResizeObserver));
  return {
    container,
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
      globalThis.ResizeObserver = originalResizeObserver;
    },
  };
}

describe('DataTable', () => {
  it('leaves remaining fluid width to columns without an explicit width', () => {
    const { container, cleanup } = renderAtWidth(<TableHarness />, 600);
    try {
      const columns = container.querySelectorAll('col');
      expect(columns[0]!.style.width).toBe('200px');
      expect(columns[1]!.style.width).toBe('');
    } finally {
      cleanup();
    }
  });

  it('offsets fixed columns by the resolved width of preceding columns', () => {
    const { container, cleanup } = renderAtWidth(<FixedTableHarness />, 600);
    try {
      const headers = container.querySelectorAll('th');
      expect(headers[0]!.style.width).toBe('250px');
      expect(headers[1]!.style.left).toBe('250px');
    } finally {
      cleanup();
    }
  });
});
