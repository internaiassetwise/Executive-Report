import { DatasetError } from './datasets';
import type { ChartPoint } from '../../shared/dashboard-charts.mjs';

export type ChartType = 'line' | 'area' | 'bar' | 'hbar' | 'donut' | 'treemap' | 'histogram' | 'scatter';
export interface DashboardKpiSpec { id: string; label: string; column: string | null; agg: string }
export interface DashboardChartSpec { id: string; type: ChartType; title: string; x: string; y: string | null; agg: string | null; grain: string | null; limit: number | null }
export interface DashboardFilterSpec { id: string; column: string; kind: 'category' | 'date' | 'number' }
export interface DashboardSpec {
  version: number; source: 'ai' | 'rules'; sheet_id: string; title: string; description: string;
  kpis: DashboardKpiSpec[]; charts: DashboardChartSpec[]; filters: DashboardFilterSpec[];
}
/** One active filter; exactly one of values / from-to / min-max is set. */
export type DashboardFilter =
  | { column: string; values: string[] }
  | { column: string; from?: string; to?: string }
  | { column: string; min?: number; max?: number };
export type FilterOption = { values: { value: string; count: number }[]; total: number } | { min: string | number | null; max: string | number | null };
export interface ChartResult {
  id: string; data: ChartPoint[]; grain?: string; groups_total?: number; others?: { label: string; y: number } | null;
  points_total?: number; sampled?: boolean; error?: string;
}
export interface DashboardResult {
  spec: DashboardSpec; filters: DashboardFilter[]; rows_total: number; rows_matched: number;
  kpis: { id: string; value: number | null }[]; charts: ChartResult[]; options?: Record<string, FilterOption>;
}

async function failure(response: Response): Promise<never> {
  const data = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  throw new DatasetError(data?.error?.message || 'คำนวณ Dashboard ไม่สำเร็จ กรุณาลองอีกครั้ง', response.status);
}

export async function queryDashboard(id: string, filters: DashboardFilter[], options: boolean, signal?: AbortSignal): Promise<DashboardResult> {
  const response = await fetch(`/api/datasets/${encodeURIComponent(id)}/dashboard`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filters, options }), signal,
  });
  if (!response.ok) await failure(response);
  return response.json() as Promise<DashboardResult>;
}

export async function exportDashboard(id: string, format: 'html' | 'pdf', filters: DashboardFilter[], filename: string, images: { id: string; data: string }[] = []) {
  const response = await fetch(`/api/datasets/${encodeURIComponent(id)}/export-dashboard`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ format, filters, ...(format === 'pdf' ? { images } : {}) }),
  });
  if (!response.ok) await failure(response);
  const href = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = `${filename.replace(/\.[^.]+$/, '')}-dashboard.${format}`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(href), 30_000);
}

/** Date bucket label -> inclusive date range for drill-down (month, day and year buckets). */
export function bucketRange(label: string): { from: string; to: string } | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(label)) return { from: label, to: label };
  if (/^\d{4}-\d{2}$/.test(label)) {
    const [year, month] = label.split('-').map(Number);
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return { from: `${label}-01`, to: `${label}-${String(last).padStart(2, '0')}` };
  }
  if (/^\d{4}$/.test(label)) return { from: `${label}-01-01`, to: `${label}-12-31` };
  return null;
}
