import type { DataType } from './datasets';
import type { DashboardSpec } from './dashboard';

export interface DatasetKpi {
  id: string; name: string; value: number | string; formatted_value: string;
  source: { sheet: string; column?: string }; method: string;
}
export interface DatasetInsight {
  id: string; title: string; description: string; importance: 'high' | 'medium' | 'low';
  kind: 'quality' | 'trend' | 'segment' | 'distribution' | 'relationship' | 'anomaly';
  evidence: { metric: string; value: number | string; method: string; sheet: string; columns: string[] };
}
export interface ProfileColumn {
  key: string; name: string; data_type: DataType; missing_count: number; missing_percentage: number; unique_count: number;
  semantic_type?: 'integer' | 'decimal' | 'date' | 'datetime' | 'boolean' | 'category' | 'text' | 'identifier' | 'mixed' | 'empty';
  role?: 'measure' | 'dimension' | 'time' | 'identifier' | 'attribute'; meaning?: 'money' | 'quantity' | 'percent' | 'score' | null; time_format?: 'iso' | 'year_month';
  statistics?: { count: number; min: number | null; max: number | null; mean: number | null; median: number | null; std: number | null; sum: number | null };
  date_range?: { min: string; max: string };
  top_values?: { value: string; count: number }[];
  outliers?: { count: number; lower: number; upper: number };
}
export interface SheetProfile {
  sheet_id: string; sheet_name: string; rows_count: number; columns: ProfileColumn[];
  duplicate_rows: number; missing_count: number; missing_percentage: number;
  correlations: { x: string; y: string; value: number; sample_size: number }[]; warnings: string[];
}
export interface DatasetChart {
  id: string; type: 'bar' | 'line' | 'histogram' | 'donut' | 'scatter'; title: string; sheet_id: string;
  x: string; y: string; x_label: string; y_label: string;
  data: { x: string | number; y: number }[]; method: string;
}
export interface DatasetAI {
  status: 'complete' | 'unavailable' | 'error'; model: string; message?: string; summary?: string;
  insights?: { title: string; description: string; evidence_ids: string[] }[];
  recommendations?: { text: string; evidence_ids: string[] }[];
  dashboard?: 'accepted' | 'rejected';
}
export interface DatasetAnalysis {
  generated_at: string; summary: string; kpis: DatasetKpi[]; insights: DatasetInsight[];
  profiles: SheetProfile[]; charts: DatasetChart[];
  report: { sections: { id: string; title: string; paragraphs: string[]; evidence_ids: string[] }[] };
  ai?: DatasetAI;
  dashboard?: DashboardSpec | null;
}
