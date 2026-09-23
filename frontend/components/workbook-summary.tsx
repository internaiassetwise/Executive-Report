import { FileSpreadsheet, ImageIcon, Link2, MessageSquareText, PieChart, Table2 } from 'lucide-react';
import type { Dataset, DataSheet } from '@/lib/datasets';

const num = (value: number) => new Intl.NumberFormat('th-TH').format(value);

const CHART_NAMES: Record<string, string> = {
  bar: 'กราฟแท่ง', hbar: 'กราฟแท่งแนวนอน', line: 'กราฟเส้น', area: 'กราฟพื้นที่', pie: 'กราฟวงกลม', doughnut: 'กราฟโดนัท',
  scatter: 'กราฟกระจาย', radar: 'กราฟเรดาร์', combo: 'กราฟผสม', bubble: 'กราฟฟอง', stock: 'กราฟหุ้น', surface: 'กราฟพื้นผิว',
};
const IMAGE_KINDS: Record<string, string> = {
  table: 'ตาราง', chart: 'กราฟ', text: 'ข้อความ', diagram: 'แผนภาพ', photo: 'ภาพถ่าย', logo: 'โลโก้', signature: 'ลายเซ็น', other: 'รูปภาพ',
};
const LINKS: Record<string, string> = { formula: 'สูตรอ้างอิง', pivot: 'Pivot Table สรุปจาก', chart: 'กราฟใช้ข้อมูลจาก' };

function howRead(sheet: DataSheet) {
  if (sheet.combined_from) return `รวม ${sheet.combined_from.length} ชีตที่หัวคอลัมน์เหมือนกัน`;
  if (sheet.source === 'image_ocr') return 'อ่านจากรูปภาพ (ควรตรวจทาน)';
  if (sheet.pivot) return `Pivot Table ${sheet.pivot}`;
  if (sheet.layout_source === 'excel_table') return 'ตาราง Excel';
  return 'ระบบระบุตำแหน่งตาราง';
}

/** What the reader found in the file: tables and where they sit, plus charts, pictures, notes and links. */
export function WorkbookSummary({ dataset }: { dataset: Dataset }) {
  const facts = dataset.workbook;
  const tables = dataset.sheets;
  const hidden = facts?.sheets.filter(sheet => sheet.state !== 'visible') || [];
  const notes = tables.flatMap(sheet => (sheet.footnotes || []).map(text => ({ sheet: sheet.name, text })));
  return <section className="office-card wb-summary" aria-label="ข้อมูลในไฟล์">
    <header><FileSpreadsheet size={18} /><div><h2>ข้อมูลในไฟล์</h2><p>ระบบอ่าน {num(tables.length)} ตาราง รวม {num(dataset.rows_count)} แถว{facts ? ` จาก ${num(facts.sheets.length)} ชีต` : ''} ตัวเลขทุกค่าในแดชบอร์ดและรายงานคำนวณจากตารางเหล่านี้</p></div></header>

    <h3><Table2 size={15} />ตารางข้อมูล</h3>
    <div className="wb-table-scroll"><table>
      <thead><tr><th>ตาราง</th><th>ตำแหน่งในไฟล์</th><th>แถว</th><th>วิธีอ่าน</th></tr></thead>
      <tbody>{tables.map(sheet => <tr key={sheet.id}>
        <td><b>{sheet.name}</b>{sheet.title_lines?.length ? <small>{sheet.title_lines.join(' · ')}</small> : null}</td>
        <td>{sheet.area ? `${sheet.source_sheet || sheet.name}!${sheet.area.ref}` : sheet.source === 'image_ocr' ? `รูปภาพที่ ${sheet.source_sheet || ''}!${sheet.image_cell || ''}` : '—'}</td>
        <td>{num(sheet.rows_count)}</td>
        <td>{howRead(sheet)}</td>
      </tr>)}</tbody>
    </table></div>

    {facts && facts.charts.length > 0 && <><h3><PieChart size={15} />กราฟที่มีอยู่ในไฟล์</h3><ul>
      {facts.charts.map(chart => <li key={chart.id}><b>{CHART_NAMES[chart.type] || 'กราฟ'}</b> {chart.title ? `“${chart.title}”` : ''} ในชีต {chart.sheet}{chart.cell ? ` (${chart.cell})` : ''}
        {chart.series.some(series => series.values_column) && <small>ข้อมูล: {chart.series.map(series => [series.values_column?.column_name, series.categories_column?.column_name].filter(Boolean).join(' ตาม ')).filter(Boolean).join(', ')}</small>}
      </li>)}
    </ul></>}

    {facts && facts.pivots.length > 0 && <><h3><Table2 size={15} />Pivot Table</h3><ul>
      {facts.pivots.map(pivot => <li key={`${pivot.sheet}-${pivot.name}`}><b>{pivot.name}</b> ในชีต {pivot.sheet}{pivot.source_sheet ? ` สรุปจากชีต ${pivot.source_sheet}${pivot.source_ref ? ` (${pivot.source_ref})` : ''}` : ''}</li>)}
    </ul></>}

    {facts && facts.images.length > 0 && <><h3><ImageIcon size={15} />รูปภาพในไฟล์</h3><ul>
      {facts.images.map(image => <li key={image.id}><b>{IMAGE_KINDS[image.kind || ''] || 'รูปภาพ'}</b> ชีต {image.sheet}{image.cell ? ` (${image.cell})` : ''} — {image.read
        ? image.description || 'อ่านแล้ว'
        : ['image/png', 'image/jpeg', 'image/webp'].includes(image.content_type) ? 'ยังไม่ได้อ่าน (รูปเล็กหรือเกินจำนวนที่อ่านต่อไฟล์)' : 'รูปแบบไฟล์ภาพนี้ระบบอ่านไม่ได้'}
        {image.table_sheet && <small>ข้อมูลตารางในรูปถูกแยกเป็นตาราง “{tables.find(sheet => sheet.id === image.table_sheet)?.name}”</small>}
      </li>)}
    </ul></>}

    {(notes.length > 0 || (facts && (facts.comments.length > 0 || facts.text_boxes.length > 0))) && <><h3><MessageSquareText size={15} />หมายเหตุและความเห็นในไฟล์</h3><ul>
      {notes.map((note, index) => <li key={`n${index}`}>{note.text}<small>ท้ายตาราง {note.sheet}</small></li>)}
      {facts?.text_boxes.map((box, index) => <li key={`t${index}`}>{box.text}<small>กล่องข้อความ ชีต {box.sheet}</small></li>)}
      {facts?.comments.map((comment, index) => <li key={`c${index}`}>{comment.text}<small>ความเห็นที่เซลล์ {comment.sheet}!{comment.cell}</small></li>)}
    </ul></>}

    {facts && facts.relationships.length > 0 && <><h3><Link2 size={15} />ความเชื่อมโยงระหว่างชีต</h3><ul>
      {facts.relationships.map((link, index) => <li key={index}>ชีต <b>{link.from}</b> {LINKS[link.via] || 'อ้างอิง'} ชีต <b>{link.to}</b>{link.via === 'formula' ? ` (${num(link.count)} สูตร)` : ''}</li>)}
    </ul></>}

    {(hidden.length > 0 || facts?.has_macros || (facts?.external_links || 0) > 0) && <p className="wb-footnote">
      {hidden.length > 0 && <>ชีตที่ถูกซ่อน: {hidden.map(sheet => sheet.name).join(', ')} (อ่านรวมไว้แล้ว) </>}
      {facts?.has_macros && <>· ไฟล์มี macro ระบบไม่ได้เรียกใช้ </>}
      {(facts?.external_links || 0) > 0 && <>· มีการอ้างอิงไฟล์ภายนอก ใช้ค่าที่บันทึกไว้ล่าสุด</>}
    </p>}
  </section>;
}
