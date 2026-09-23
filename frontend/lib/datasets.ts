export type DataType = 'number' | 'text' | 'date' | 'boolean' | 'mixed' | 'empty';
export interface DataColumn { key: string; name: string; data_type: DataType }
export interface DataSheet {
  id: string;
  name: string;
  rows_count: number;
  columns: DataColumn[];
  header_row: number;
  warnings: string[];
}
export interface Dataset {
  filename: string;
  rows_count: number;
  columns_count: number;
  sheets: DataSheet[];
  warnings: string[];
  created_at: string;
}
export interface DatasetJob {
  id: string;
  status: 'processing' | 'ready' | 'error';
  stage: string;
  progress: number;
  dataset?: Dataset;
  analysis?: DatasetAnalysis;
  /** Present when the workbook is a BOQ benchmark comparison with an engine-rendered report. */
  boq?: { vendors: string[]; benchmark?: string; headline?: string };
  error?: { code: string; message: string };
}
export interface DatasetConfig {
  max_file_size: number;
  accepted_extensions: string[];
  max_rows: number;
  max_columns: number;
  max_cells: number;
  retention_minutes: number;
  auto_analyze?: boolean;
  ai?: { configured: boolean; model: string };
}
export interface DataPage {
  rows: { row_number: number; values: Record<string, string | number | boolean | null> }[];
  total_rows: number;
  page: number;
  page_size: number;
  truncated_cells: number;
  max_cell_characters: number;
}
export class DatasetError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}

/** Fired when the backend rejects a request for a missing or expired access cookie. */
export const ACCESS_REQUIRED_EVENT = 'asw:access-required';
export interface AccessState { required: boolean; authenticated: boolean }

async function readJson<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => null) as { error?: string | { message?: string } } | null;
  if (response.status === 401 && typeof window !== 'undefined') window.dispatchEvent(new Event(ACCESS_REQUIRED_EVENT));
  if (!response.ok) {
    const message = typeof data?.error === 'string' ? data.error : data?.error?.message;
    throw new DatasetError(message || 'เชื่อมต่อบริการข้อมูลไม่สำเร็จ กรุณาลองอีกครั้ง', response.status);
  }
  if (!data) throw new DatasetError('บริการส่งข้อมูลกลับมาไม่สมบูรณ์ กรุณาลองอีกครั้ง', 502);
  return data as T;
}

export const getAccess = (signal?: AbortSignal) =>
  fetch('/api/access', { signal, cache: 'no-store' }).then(readJson<AccessState>);
export const unlockAccess = (password: string) =>
  fetch('/api/access', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) }).then(readJson<AccessState>);
export const getDatasetConfig = (signal?: AbortSignal) =>
  fetch('/api/datasets/config', { signal, cache: 'no-store' }).then(readJson<DatasetConfig>);
export const getDatasetJob = (id: string, signal?: AbortSignal) =>
  fetch(`/api/datasets/${encodeURIComponent(id)}`, { signal, cache: 'no-store' }).then(readJson<DatasetJob>);
export const getDataPage = (id: string, query: URLSearchParams, signal?: AbortSignal) =>
  fetch(`/api/datasets/${encodeURIComponent(id)}/rows?${query}`, { signal, cache: 'no-store' }).then(readJson<DataPage>);
export const analyzeDataset = (id: string, objective = '') =>
  fetch(`/api/datasets/${encodeURIComponent(id)}/analyze`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ objective }),
  }).then(readJson<DatasetJob>);

export async function exportDataset(id: string, format: 'pdf' | 'xlsx' | 'csv', filename: string, sheet?: string) {
  const query = new URLSearchParams({ format });
  if (sheet) query.set('sheet', sheet);
  const response = await fetch(`/api/datasets/${encodeURIComponent(id)}/export?${query}`);
  if (!response.ok) await readJson(response);
  const blob = await response.blob();
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = `${filename.replace(/\.[^.]+$/, '')}-${format === 'csv' ? 'data' : 'report'}.${format}`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(href), 30_000);
}
export async function removeDataset(id: string) {
  const response = await fetch(`/api/datasets/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!response.ok && response.status !== 404 && response.status !== 410) await readJson(response);
}

// XHR exposes actual bytes sent. Backend polling reports parsing stages separately.
export function uploadDataset(file: File, onProgress: (percent: number) => void, signal: AbortSignal) {
  return new Promise<DatasetJob>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const finish = () => signal.removeEventListener('abort', abort);
    xhr.open('POST', '/api/datasets');
    xhr.timeout = 120_000;
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100));
    };
    xhr.onload = () => {
      finish();
      void readJson<DatasetJob>(new Response(xhr.responseText, { status: xhr.status || 502 })).then(resolve, reject);
    };
    xhr.onerror = () => { finish(); reject(new Error('ส่งไฟล์ไม่สำเร็จ ตรวจสอบการเชื่อมต่อแล้วลองอีกครั้ง')); };
    xhr.ontimeout = () => { finish(); reject(new Error('ส่งไฟล์นานเกินกำหนด กรุณาลองอีกครั้ง')); };
    xhr.onabort = () => { finish(); reject(new DOMException('Aborted', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { finish(); reject(new DOMException('Aborted', 'AbortError')); return; }
    const form = new FormData();
    form.append('file', file);
    xhr.send(form);
  });
}
import type { DatasetAnalysis } from './dataset-analysis';
