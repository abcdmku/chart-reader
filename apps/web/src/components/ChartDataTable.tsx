import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type Column,
  type ColumnFiltersState,
  type ColumnOrderState,
  type ColumnSizingState,
  type SortingState,
} from '@tanstack/react-table';
import type { ChartRow } from '../types';

const LS_COL_ORDER = 'chart-table-col-order';
const LS_COL_SIZING = 'chart-table-col-sizing';

function loadJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

const columnHelper = createColumnHelper<ChartRow>();

const defaultColumns = [
  columnHelper.accessor('entry_date', {
    id: 'entry_date',
    header: 'Date',
    cell: (info) => info.getValue(),
    minSize: 80,
    size: 110,
  }),
  columnHelper.accessor('chart_title', {
    id: 'chart_title',
    header: 'Chart',
    cell: (info) => info.getValue(),
    minSize: 80,
    size: 160,
  }),
  columnHelper.accessor('chart_section', {
    id: 'chart_section',
    header: 'Section',
    cell: (info) => info.getValue(),
    minSize: 60,
    size: 120,
  }),
  columnHelper.accessor('this_week_rank', {
    id: 'this_week_rank',
    header: '#',
    cell: (info) => info.getValue() ?? '',
    minSize: 40,
    size: 55,
    sortUndefined: 'last',
  }),
  columnHelper.accessor('last_week_rank', {
    id: 'last_week_rank',
    header: 'Last',
    cell: (info) => info.getValue() ?? '',
    minSize: 40,
    size: 55,
    sortUndefined: 'last',
  }),
  columnHelper.accessor('two_weeks_ago_rank', {
    id: 'two_weeks_ago_rank',
    header: '2w',
    cell: (info) => info.getValue() ?? '',
    minSize: 40,
    size: 55,
    sortUndefined: 'last',
  }),
  columnHelper.accessor('weeks_on_chart', {
    id: 'weeks_on_chart',
    header: 'Wks',
    cell: (info) => info.getValue() ?? '',
    minSize: 40,
    size: 55,
    sortUndefined: 'last',
  }),
  columnHelper.accessor('title', {
    id: 'title',
    header: 'Title',
    cell: (info) => <span className="font-medium text-zinc-100">{info.getValue()}</span>,
    minSize: 100,
    size: 220,
  }),
  columnHelper.accessor('artist', {
    id: 'artist',
    header: 'Artist',
    cell: (info) => info.getValue(),
    minSize: 80,
    size: 160,
  }),
  columnHelper.accessor('label', {
    id: 'label',
    header: 'Label',
    cell: (info) => info.getValue(),
    minSize: 60,
    size: 140,
  }),
  columnHelper.accessor('source_file', {
    id: 'source_file',
    header: 'Source',
    cell: (info) => <span className="truncate">{info.getValue()}</span>,
    minSize: 80,
    size: 140,
  }),
];

const defaultColumnIds = defaultColumns.map((c) => c.id!);

function csvEscape(value: unknown): string {
  if (value == null) return '';
  const text = String(value);
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function columnHeaderLabel(column: Column<ChartRow, unknown>): string {
  const header = column.columnDef.header;
  return typeof header === 'string' ? header : column.id;
}

function ColumnFilter({ column }: { column: Column<ChartRow, unknown> }) {
  const value = column.getFilterValue();
  return (
    <input
      type="text"
      value={(value ?? '') as string}
      onChange={(e) => column.setFilterValue(e.target.value || undefined)}
      placeholder="Filter…"
      className="w-full rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-zinc-300 placeholder-zinc-700 outline-none focus-visible:border-zinc-600"
      aria-label={`Filter ${column.columnDef.header as string}`}
    />
  );
}

function SortIndicator({ column }: { column: Column<ChartRow, unknown> }) {
  const sorted = column.getIsSorted();
  if (!sorted) return <span className="ml-1 text-zinc-700">↕</span>;
  const index = column.getSortIndex();
  return (
    <span className="ml-1 text-zinc-300">
      {sorted === 'asc' ? '↑' : '↓'}
      {index > 0 ? <sup className="ml-0.5 text-zinc-500">{index + 1}</sup> : null}
    </span>
  );
}

type ChartDataTableProps = {
  rows: ChartRow[];
  totalRows: number;
  latestOnly: boolean;
  onLatestOnlyChange: (value: boolean) => void | Promise<void>;
};

export function ChartDataTable({ rows, totalRows, latestOnly, onLatestOnlyChange }: ChartDataTableProps) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = useState('');

  // Restore persisted column order & sizing from localStorage
  const [columnOrder, setColumnOrder] = useState<ColumnOrderState>(() => {
    const saved = loadJson<string[]>(LS_COL_ORDER);
    // Validate: must contain exactly the same column ids
    if (saved && saved.length === defaultColumnIds.length && defaultColumnIds.every((id) => saved.includes(id))) {
      return saved;
    }
    return defaultColumnIds;
  });

  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>(() => {
    return loadJson<ColumnSizingState>(LS_COL_SIZING) ?? {};
  });

  // Persist to localStorage on change
  useEffect(() => {
    localStorage.setItem(LS_COL_ORDER, JSON.stringify(columnOrder));
  }, [columnOrder]);

  const saveSizingTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    // Debounce sizing saves since resizing fires rapidly
    clearTimeout(saveSizingTimer.current);
    saveSizingTimer.current = setTimeout(() => {
      localStorage.setItem(LS_COL_SIZING, JSON.stringify(columnSizing));
    }, 300);
    return () => clearTimeout(saveSizingTimer.current);
  }, [columnSizing]);

  // Measure container width for auto-expanding columns
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Drag-and-drop reordering state
  const dragColumnRef = useRef<string | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null);

  const onDragStart = useCallback((e: React.DragEvent, columnId: string) => {
    dragColumnRef.current = columnId;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', columnId);
  }, []);

  const onDragOver = useCallback((e: React.DragEvent, columnId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverColumn(columnId);
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent, targetId: string) => {
      e.preventDefault();
      const sourceId = dragColumnRef.current;
      if (!sourceId || sourceId === targetId) {
        setDragOverColumn(null);
        dragColumnRef.current = null;
        return;
      }
      setColumnOrder((prev) => {
        const next = [...prev];
        const fromIdx = next.indexOf(sourceId);
        const toIdx = next.indexOf(targetId);
        if (fromIdx === -1 || toIdx === -1) return prev;
        next.splice(fromIdx, 1);
        next.splice(toIdx, 0, sourceId);
        return next;
      });
      setDragOverColumn(null);
      dragColumnRef.current = null;
    },
    [],
  );

  const onDragEnd = useCallback(() => {
    setDragOverColumn(null);
    dragColumnRef.current = null;
  }, []);

  const table = useReactTable({
    data: rows,
    columns: defaultColumns,
    state: { sorting, columnFilters, globalFilter, columnOrder, columnSizing },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    onColumnOrderChange: setColumnOrder,
    onColumnSizingChange: setColumnSizing,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    enableMultiSort: true,
    isMultiSortEvent: () => true,
    columnResizeMode: 'onChange',
  });

  const filteredCount = table.getFilteredRowModel().rows.length;

  const handleExportCsv = useCallback(() => {
    const columns = table.getVisibleLeafColumns();
    const headerLine = columns.map((column) => csvEscape(columnHeaderLabel(column))).join(',');
    const bodyLines = table.getRowModel().rows.map((row) =>
      columns.map((column) => csvEscape(row.getValue(column.id))).join(','),
    );
    const csv = [headerLine, ...bodyLines].join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    link.href = url;
    link.download = `chart-view-${timestamp}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, [table]);

  // Compute effective widths: if total defined widths < container, scale up proportionally
  const definedTotal = table.getTotalSize();
  const scale = containerWidth > 0 && definedTotal < containerWidth ? containerWidth / definedTotal : 1;

  function colWidth(colId: string, baseSize: number): number {
    return (columnSizing[colId] ?? baseSize) * scale;
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2.5">
        <div className="flex items-center gap-3">
          <label className="sr-only" htmlFor="global-search">
            Search all columns
          </label>
          <input
            id="global-search"
            type="search"
            placeholder="Search all columns…"
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            className="w-64 rounded border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 outline-none focus-visible:border-zinc-600"
          />
          {columnFilters.length > 0 || globalFilter ? (
            <button
              onClick={() => {
                setColumnFilters([]);
                setGlobalFilter('');
              }}
              className="rounded border border-zinc-800 px-2 py-1 text-xs text-zinc-500 hover:text-zinc-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-zinc-400"
            >
              Clear filters
            </button>
          ) : null}
        </div>
        <div className="flex items-center gap-3 text-xs text-zinc-500">
          <label
            className="flex cursor-pointer select-none items-center gap-2 text-xs text-zinc-500 hover:text-zinc-300"
            title="Hide duplicate rows from earlier reruns"
          >
            <input
              type="checkbox"
              checked={latestOnly}
              onChange={(e) => void onLatestOnlyChange(e.currentTarget.checked)}
              className="h-4 w-4 cursor-pointer rounded border border-zinc-700 bg-zinc-900 accent-emerald-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-zinc-400"
              aria-label="Latest run only"
            />
            Latest only
          </label>
          <span>
            {filteredCount !== totalRows
              ? `${filteredCount} of ${totalRows} rows`
              : `${totalRows} rows`}
          </span>
          <button
            type="button"
            onClick={handleExportCsv}
            className="rounded border border-zinc-700 px-3 py-1.5 text-zinc-300 hover:border-zinc-500 hover:text-zinc-100"
          >
            Export CSV
          </button>
        </div>
      </div>

      {/* Table */}
      <div ref={containerRef} className="flex-1 overflow-auto">
        <table
          className="w-full border-separate border-spacing-0 text-xs"
          style={{ minWidth: definedTotal }}
        >
          <thead className="sticky top-0 z-10">
            {/* Column headers — sortable + draggable + resizable */}
            <tr className="bg-zinc-950">
              {table.getHeaderGroups()[0].headers.map((header) => (
                <th
                  key={header.id}
                  onDragOver={(e) => onDragOver(e, header.column.id)}
                  onDrop={(e) => onDrop(e, header.column.id)}
                  className={`relative border-b border-r border-zinc-800 px-2 py-2.5 text-left font-medium text-zinc-500 ${
                    dragOverColumn === header.column.id ? 'bg-zinc-800/50' : ''
                  }`}
                  style={{
                    width: colWidth(header.column.id, header.getSize()),
                  }}
                >
                  <span className="flex items-center gap-1">
                    {/* Drag handle — only this element is draggable */}
                    <span
                      draggable
                      onDragStart={(e) => onDragStart(e, header.column.id)}
                      onDragEnd={onDragEnd}
                      className="cursor-grab text-zinc-700 hover:text-zinc-500 active:cursor-grabbing"
                      title="Drag to reorder"
                    >
                      ⠿
                    </span>
                    {/* Sortable label */}
                    <span
                      onClick={header.column.getToggleSortingHandler()}
                      className="cursor-pointer select-none hover:text-zinc-300"
                    >
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      <SortIndicator column={header.column} />
                    </span>
                  </span>
                  {/* Resize handle */}
                  <div
                    onMouseDown={header.getResizeHandler()}
                    onTouchStart={header.getResizeHandler()}
                    className={`absolute right-0 top-0 h-full w-1.5 cursor-col-resize select-none touch-none hover:bg-zinc-600 ${
                      header.column.getIsResizing() ? 'bg-zinc-500' : ''
                    }`}
                  />
                </th>
              ))}
            </tr>
            {/* Column filters */}
            <tr className="bg-zinc-950/90">
              {table.getHeaderGroups()[0].headers.map((header) => (
                <th
                  key={`filter-${header.id}`}
                  className="border-b border-r border-zinc-800 px-2 py-1.5"
                  style={{
                    width: colWidth(header.column.id, header.getSize()),
                  }}
                >
                  <ColumnFilter column={header.column} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.getRowModel().rows.length === 0 ? (
              <tr>
                <td
                  colSpan={defaultColumns.length}
                  className="px-4 py-16 text-center text-zinc-600"
                >
                  {rows.length === 0
                    ? 'No data extracted yet.'
                    : 'No rows match the current filters.'}
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row) => (
                <tr key={row.id} className="text-zinc-300 hover:bg-zinc-900/40">
                  {row.getVisibleCells().map((cell) => (
                    <td
                      key={cell.id}
                      className="border-b border-r border-zinc-800/30 px-2 py-1.5 tabular-nums"
                      style={{
                        width: colWidth(cell.column.id, cell.column.getSize()),
                      }}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
