"""Generate explicitly synthetic demonstration data, independent of the analysis engine."""
from pathlib import Path
import csv
root=Path(__file__).resolve().parents[1]
with (root/'public/sample-data.csv').open('w',encoding='utf-8-sig',newline='') as f:
    w=csv.writer(f);w.writerow(['Date','Team','Request ID','Processing hours','Completed items','Quality score'])
    for month in range(1,13):
        for j,team in enumerate(['North','Central','South']):
            for batch in range(2):
                hours=round(12+month*.7+j*2+batch*1.5,1)
                if month==10 and j==1 and batch==1:hours=72
                w.writerow([f'2026-{month:02d}-{5+batch*15:02d}',team,f'REQ-{month:02d}{j}{batch}',hours,20+month*3+j*4+batch*2,round(88+month*.35-j*.6+batch*.4,1)])
