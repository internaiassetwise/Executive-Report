export interface SourceRef {table_id:string;sheet:string;range:string;source_columns:string[]}
export interface ColumnProfile {name:string;normalized_name:string;type:string;semantic_type:string;role:string;unique:number;missing:number;null_pct:number;valid_count:number;invalid_count:number;samples:string[];confidence:number;stats?:Record<string,number>}
export interface Opportunity {id:string;type:string;title:string;reason:string;columns:number[];source_columns:string[]}
export interface WorkbookOpportunity {type:string;title:string;reason:string;analyses_count:number;tables_count:number}
export interface Quality {missing:number;duplicates:number;completeness:number;issues:{kind:string;severity:string;count:number;message:string;source?:SourceRef}[]}
export interface ExcludedRow {row:number;reason:string;source?:SourceRef}
export interface TableProfile {id:string;name:string;sheet:string;range:string;header_row:number|null;confidence:number;rows_count:number;columns_count:number;columns:ColumnProfile[];preview:unknown[][];quality:Quality;excluded_rows:ExcludedRow[];opportunities:Opportunity[]}
export interface SheetProfile {name:string;state:string;tables_count:number;rows_count:number;table_ids:string[];status:'ready'|'complete'|'partial'|'no_table';reason:string;analyses_count?:number;errors_count?:number}
export interface WorkbookProfile {filename:string;sheets_count:number;tables_count:number;rows_count:number;tables:TableProfile[];sheets:SheetProfile[];summary:{rows_count:number;columns_count:number;measures_count:number;cells_count:number;quality:Quality};opportunities:WorkbookOpportunity[];notes:string[];understanding:{dataset_summary:string;possible_domain:string;grain:string;limitations:string[]}}
export interface AnalysisResult {id:string;title:string;type:string;finding:string;data:Record<string,any>;chart:null|{type:string;points:any[];unit:string;x_label?:string};evidence_id:string;method:string;source?:SourceRef}
export interface Evidence {evidence_id:string;calculation_id:string;type:string;source:SourceRef;data:Record<string,any>;finding:string;confidence:number;method:string;limitations:string[]}
export interface Report {
  metadata:{title:string;table:string;source_range:string;objective:string;generated_at:string;engine:string;interpretation_mode:string};
  dataset_overview:{rows_count:number;columns_count:number;sheet:string;range:string;columns:ColumnProfile[];scope?:'workbook';sheets_count?:number;tables_count?:number;cells_count?:number;sheets?:SheetProfile[];tables?:{id:string;name:string;sheet:string;range:string;rows_count:number;columns_count:number;analyses_count:number;errors_count:number;status:string}[]};
  data_quality:Quality;excluded_rows:ExcludedRow[];analyses:AnalysisResult[];evidence:Evidence[];sections:string[];executive_summary:string[];recommendations:string[];limitations:string[];
  errors?:{analysis_id:string;title:string;source:SourceRef;message:string}[];
  ai?:{interpretation:string;recommendation:string;evidence_ids:string[]}[];
}
