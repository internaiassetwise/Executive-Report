export interface SourceRef {table_id:string;sheet:string;range:string;source_columns:string[]}
export interface ColumnProfile {name:string;normalized_name:string;type:string;semantic_type:string;role:string;unique:number;missing:number;null_pct:number;valid_count:number;invalid_count:number;samples:string[];confidence:number;stats?:Record<string,number>}
export interface Opportunity {id:string;type:string;title:string;reason:string;columns:number[];source_columns:string[]}
export interface WorkbookOpportunity {type:string;title:string;reason:string;analyses_count:number;tables_count:number}
export interface Quality {missing:number;duplicates:number;completeness:number;issues:{kind:string;severity:string;count:number;message:string;source?:SourceRef}[]}
export interface ExcludedRow {row:number;reason:string;source?:SourceRef}
export interface PlanningContext {rows_scanned:number;columns:unknown[];samples:{row:number;values:unknown[];reasons:string[]}[];sampling:string;transport_samples_omitted?:number}
export interface TableProfile {planning_context?:PlanningContext;id:string;name:string;sheet:string;range:string;header_row:number|null;confidence:number;rows_count:number;columns_count:number;columns:ColumnProfile[];preview:unknown[][];quality:Quality;excluded_rows:ExcludedRow[];opportunities:Opportunity[]}
export interface SheetProfile {name:string;state:string;tables_count:number;rows_count:number;table_ids:string[];status:'ready'|'complete'|'partial'|'no_table';reason:string;analyses_count?:number;errors_count?:number}
export interface WorkbookProfile {filename:string;sheets_count:number;tables_count:number;rows_count:number;tables:TableProfile[];sheets:SheetProfile[];summary:{rows_count:number;columns_count:number;measures_count:number;cells_count:number;quality:Quality};opportunities:WorkbookOpportunity[];notes:string[];understanding:{dataset_summary:string;possible_domain:string;grain:string;limitations:string[]}}
export interface AnalysisResult {id:string;title:string;type:string;finding:string;narrative?:string;data:Record<string,any>;chart:null|{type:string;points:any[];unit:string;x_label?:string};evidence_id:string;method:string;source?:SourceRef}
export interface Evidence {evidence_id:string;calculation_id:string;type:string;source:SourceRef;data:Record<string,any>;finding:string;confidence:number;method:string;limitations:string[]}
// Per-axis metrics (quantity_over, labour_dev_pct, …) arrive under the index
// signature; the named fields are the ones every group carries.
export interface BoqTotals {total:number;benchmark_items:number;comparable:number;out_of_scope:number;not_quoted:number;original:number;normalized:number;savings:number;savings_pct:number|null;stated_normalized:number|null;parent_rows:number;parent_value:number;mismatch:number;[metric:string]:unknown}
export interface BoqGroup extends BoqTotals {group:string;sheets:string[]}
export interface BoqVendor {vendor:string;benchmark:string;project:string|null;filename:string;axes:string[];sheets_used:string[];sheets_skipped:{sheet:string;reason:string}[];file_tolerance:number|null;tolerance_sample:number;tolerance:number;tolerance_source:string;groups:BoqGroup[];total:BoqTotals;insights:string[]}
export interface BoqReport {
  writer?:ReportWriter;
  tolerance:number;tolerance_source:'declared'|'inferred'|'default';vendors:BoqVendor[];files:string[];files_skipped:{filename:string;reason:string}[];groups:string[];
  comparison:Record<string,Record<string,Record<string,number|null>>>;signatures:{vendor:string;pattern:string;top_groups:string}[];strategy:string[];
  executive:{rows:{vendor:string;original:number;normalized:number;savings:number;savings_pct:number|null}[];summary:string;bullets:string[];headline:string};
}
export type BoqResult={mode:'boq';report:BoqReport;html:string}|{mode:'generic';book:WorkbookProfile}|{mode:'none'};
export interface Report {
  plan?:AIPlan;
  dynamic_sections?:{title:string;question:string;analysis_ids:string[];display_analysis_ids?:string[];narrative?:string}[];
  writer?:ReportWriter;
  metadata:{title:string;table:string;source_range:string;objective:string;generated_at:string;engine:string;interpretation_mode:string};
  dataset_overview:{rows_count:number;columns_count:number;sheet:string;range:string;columns:ColumnProfile[];scope?:'workbook';sheets_count?:number;tables_count?:number;cells_count?:number;sheets?:SheetProfile[];tables?:{id:string;name:string;sheet:string;range:string;rows_count:number;columns_count:number;analyses_count:number;errors_count:number;status:string}[]};
  data_quality:Quality;excluded_rows:ExcludedRow[];analyses:AnalysisResult[];evidence:Evidence[];sections:string[];executive_summary:string[];recommendations:string[];limitations:string[];
  errors?:{analysis_id:string;title:string;source:SourceRef;message:string}[];
  ai?:{interpretation:string;recommendation:string;evidence_ids:string[]}[];
}
export interface ReportWriter {status:'complete';model:string;generated_at:string;sources:unknown[];output:unknown[];requests?:unknown[]}
export interface AIPlan {processing?:{parts:number;completed:number;partial:boolean;failed:{table_id:string;part:number;reason:string}[];coverage:{table_id:string;sheet:string;range:string;rows:number;eligible:number;selected:number;parts:number;failed_parts:number}[]};requests?:unknown[];title:string;understanding:string;limitations:string[];sections:{title:string;question:string;analyses:{table_id:string;analysis_id:string}[]}[];model:string;receipt?:unknown}
