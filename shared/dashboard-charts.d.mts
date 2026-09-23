export interface ChartPoint { x: string | number; y: number; from?: number; to?: number }
export interface ComputedChart {
  id: string; type: 'line' | 'area' | 'bar' | 'hbar' | 'donut' | 'treemap' | 'histogram' | 'scatter';
  title: string; x: string; y: string | null; agg: string | null; grain?: string | null; limit?: number | null;
  x_name?: string; y_name?: string; data?: ChartPoint[]; others?: { label: string; y: number } | null;
  groups_total?: number; points_total?: number; sampled?: boolean; error?: string;
}
export declare const PALETTE: string[];
export declare const OTHERS_COLOR: string;
export declare const AGG_NAMES: Record<string, string>;
export declare function escapeText(value: unknown): string;
export declare function formatFull(value: unknown): string;
export declare function formatCompact(value: unknown): string;
export declare function formatNumber(value: number | null | undefined, meaning?: string | null, agg?: string): string;
export declare function describeFilter(filter: Record<string, unknown> & { column: string }, column?: { name: string }): { label: string; text: string };
export declare function seriesName(chart: ComputedChart): string;
export declare function chartOption(chart: ComputedChart, options?: { interactive?: boolean }): Record<string, unknown> | null;
