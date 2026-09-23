import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { chartOption, formatFull } from '../../shared/dashboard-charts.mjs';

// Standalone export: one file that opens offline. ECharts and the shared chart
// builder are inlined; data is aggregated results only, never source rows.
const require = createRequire(import.meta.url);
let inlineScripts;
function scripts() {
  if (!inlineScripts) {
    const echarts = readFileSync(require.resolve('echarts/dist/echarts.min.js'), 'utf8');
    const builder = readFileSync(new URL('../../shared/dashboard-charts.mjs', import.meta.url), 'utf8').replace(/^export /gm, '');
    inlineScripts = [echarts, builder].map(source => source.replace(/<\/(script)/gi, '<\\/$1'));
  }
  return inlineScripts;
}

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
// JSON inside <script type="application/json"> must not be able to close the element.
const escaped = code => String.fromCharCode(92) + 'u' + code.toString(16).padStart(4, '0');
const safeJson = value => JSON.stringify(value).replaceAll('<', escaped(0x3c)).replaceAll(String.fromCharCode(0x2028), escaped(0x2028)).replaceAll(String.fromCharCode(0x2029), escaped(0x2029));

function chartTable(chart) {
  const rows = [...(chart.data || []), ...(chart.others ? [{ x: chart.others.label, y: chart.others.y }] : [])];
  if (!rows.length) return '';
  const head = chart.type === 'scatter' ? [chart.x_name, chart.y_name] : [chart.x_name || 'กลุ่ม', chart.type === 'histogram' ? 'จำนวนแถว' : chart.y_name || 'จำนวนแถว'];
  return `<details><summary>ข้อมูลของกราฟ (${rows.length.toLocaleString('en-US')} รายการ)</summary><table><thead><tr><th>${escapeHtml(head[0])}</th><th>${escapeHtml(head[1])}</th></tr></thead><tbody>${rows.slice(0, 200).map(row => `<tr><td>${escapeHtml(formatFull(row.x))}</td><td class="num">${escapeHtml(formatFull(row.y))}</td></tr>`).join('')}</tbody></table></details>`;
}

export function renderDashboardHtml(document) {
  const [echarts, builder] = scripts();
  const generated = new Date(document.generated_at).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' });
  const filters = document.filters.length ? document.filters.map(item => `<span class="chip">${escapeHtml(item.label)}: ${escapeHtml(item.text)}</span>`).join('') : '<span class="muted">ไม่มีตัวกรอง (ข้อมูลทั้งหมด)</span>';
  const kpis = document.kpis.map(kpi => `<section class="kpi"><span>${escapeHtml(kpi.label)}</span><strong title="${escapeHtml(formatFull(kpi.value))}">${escapeHtml(kpi.text)}</strong></section>`).join('');
  const panels = document.charts.map(chart => `<section class="panel${['line', 'area'].includes(chart.type) ? ' wide' : ''}"><h3>${escapeHtml(chart.title)}</h3>${chart.error ? `<p class="muted">${escapeHtml(chart.error)}</p>` : chartOption(chart, { interactive: false }) ? `<div class="chart" id="chart-${escapeHtml(chart.id)}" role="img" aria-label="${escapeHtml(chart.title)}"></div>` : '<p class="muted">ไม่มีข้อมูลตามตัวกรองนี้</p>'}${chart.sampled ? `<p class="note">แสดงตัวอย่างจุดจาก ${escapeHtml(formatFull(chart.points_total))} คู่ข้อมูล</p>` : ''}${chartTable(chart)}</section>`).join('');
  const insights = document.insights.map(item => `<li><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.description)}</p><small>หลักฐาน: ${item.evidence.map(e => `${escapeHtml(e.id)}${e.method ? ` · ${escapeHtml(e.method)}` : ''}`).join(' | ')}</small></li>`).join('');
  return `<!doctype html>
<html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:">
<title>${escapeHtml(document.title)}</title>
<style>
:root{--navy:#123f6d;--ink:#192d47;--muted:#5c6f84;--line:#e3e9f0;--bg:#f5f7fb}
*{box-sizing:border-box}body{margin:0;font-family:"Leelawadee UI","Noto Sans Thai",system-ui,sans-serif;background:var(--bg);color:var(--ink);font-size:14px}
header{background:var(--navy);color:#fff;padding:22px max(16px,calc((100vw - 1200px)/2))}header h1{margin:0 0 6px;font-size:24px;font-weight:600}header p{margin:0;opacity:.85}
main{max-width:1200px;margin:0 auto;padding:18px 16px 40px}.meta{display:flex;flex-wrap:wrap;gap:8px 18px;color:var(--muted);font-size:12px;margin-bottom:12px}
.chip{display:inline-block;background:#e9f0f8;color:var(--navy);border-radius:999px;padding:3px 10px;margin:0 6px 6px 0;font-size:12px}.muted{color:var(--muted)}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:14px 0}.kpi{background:#fff;border:1px solid var(--line);border-radius:10px;padding:14px 16px}.kpi span{display:block;color:var(--muted);font-size:12px}.kpi strong{display:block;font-size:26px;margin-top:6px;color:var(--navy)}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.panel{background:#fff;border:1px solid var(--line);border-radius:10px;padding:14px 16px;min-width:0}.panel.wide{grid-column:1/-1}.panel h3{margin:0 0 6px;font-size:15px}.chart{height:300px}
details{margin-top:8px;font-size:12px}table{border-collapse:collapse;width:100%;margin-top:6px}th,td{border-bottom:1px solid var(--line);padding:5px 6px;text-align:left}td.num{text-align:right;font-variant-numeric:tabular-nums}
.insights{background:#fff;border:1px solid var(--line);border-radius:10px;padding:16px 20px;margin-top:14px}.insights li{margin-bottom:12px}.insights p{margin:4px 0}.insights small,.note{color:var(--muted);font-size:11px}
footer{color:var(--muted);font-size:11px;margin-top:18px}
@media (max-width:760px){.grid{grid-template-columns:1fr}}
@media print{@page{size:A4 landscape;margin:12mm}body{background:#fff}header{print-color-adjust:exact;-webkit-print-color-adjust:exact}.panel,.kpi,.insights{break-inside:avoid}details{display:none}}
</style></head><body>
<header><h1>${escapeHtml(document.title)}</h1><p>${escapeHtml(document.description || '')}</p></header>
<main>
<div class="meta"><span>ไฟล์: ${escapeHtml(document.filename)} · ชีต ${escapeHtml(document.sheet)}</span><span>สร้างเมื่อ ${escapeHtml(generated)}</span><span>แถวที่ใช้ ${escapeHtml(formatFull(document.rows_matched))} จาก ${escapeHtml(formatFull(document.rows_total))}</span></div>
<div>${filters}</div>
<div class="kpis">${kpis}</div>
<div class="grid">${panels}</div>
${insights ? `<section class="insights"><h2>ข้อสังเกตสำคัญ</h2>${document.ai_summary ? `<p>${escapeHtml(document.ai_summary)}</p>` : ''}<ul>${insights}</ul></section>` : ''}
<footer>ตัวเลขทุกค่าคำนวณจากข้อมูลทุกแถวที่ตรงตามตัวกรองในขณะส่งออก ไฟล์นี้เก็บเฉพาะผลสรุป ไม่มีข้อมูลรายแถวต้นฉบับ</footer>
</main>
<script type="application/json" id="dashboard-data">${safeJson(document.charts)}</script>
<script>${echarts}</script>
<script>${builder}
(function(){var charts=JSON.parse(document.getElementById('dashboard-data').textContent);var instances=[];charts.forEach(function(chart){var node=document.getElementById('chart-'+chart.id);var option=chartOption(chart,{interactive:true});if(!node||!option)return;var instance=echarts.init(node);instance.setOption(option);instances.push(instance);});window.addEventListener('resize',function(){instances.forEach(function(i){i.resize();});});window.addEventListener('beforeprint',function(){instances.forEach(function(i){i.resize();});});})();
</script>
</body></html>`;
}
