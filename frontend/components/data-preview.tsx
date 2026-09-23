'use client';

import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Search, X } from 'lucide-react';
import { getDataPage, type DataPage, type DataSheet, type DataType } from '@/lib/datasets';

const typeLabels: Record<DataType, string> = {
  number: 'ตัวเลข', text: 'ข้อความ', date: 'วันที่', boolean: 'จริง / เท็จ', mixed: 'หลายชนิด', empty: 'ว่าง',
};
const count = (value: number) => value.toLocaleString('th-TH');

export function DataPreview({ id, sheet }: { id: string; sheet: DataSheet }) {
  const [data, setData] = useState<DataPage | null>(null);
  const [search, setSearch] = useState('');
  const [column, setColumn] = useState('');
  const [sort, setSort] = useState('');
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    // Coalesce typing into one server query; never load the whole sheet into React.
    const timer = setTimeout(() => {
      setBusy(true);
      setError('');
      const query = new URLSearchParams({ sheet: sheet.id, page: String(page), page_size: String(pageSize), search, direction });
      if (sort) query.set('sort', sort);
      if (column) query.set('column', column);
      void getDataPage(id, query, controller.signal).then(result => {
        if (!controller.signal.aborted) setData(result);
      }).catch(reason => {
        if (!controller.signal.aborted) { setData(null); setError(reason instanceof Error ? reason.message : 'โหลดตารางไม่สำเร็จ'); }
      }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    }, search ? 250 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [id, sheet.id, page, pageSize, search, column, sort, direction, retry]);

  const pages = data ? Math.max(1, Math.ceil(data.total_rows / data.page_size)) : 1;
  function changeSort(key: string) {
    setDirection(sort === key && direction === 'asc' ? 'desc' : 'asc');
    setSort(key);
    setPage(1);
  }

  return <section className="data-table-section" aria-label="ตัวอย่างข้อมูล">
    <div className="data-table-tools">
      <label className="data-search">
        <Search size={18} />
        <input aria-label="ค้นหาข้อมูล" placeholder="ค้นหาในข้อมูล…" value={search} maxLength={200} onChange={event => { setSearch(event.target.value); setPage(1); }} />
        {search && <button aria-label="ล้างการค้นหา" onClick={() => { setSearch(''); setPage(1); }}><X size={15} /></button>}
      </label>
      <label className="data-select-label">ค้นหาใน
        <select aria-label="คอลัมน์ที่ต้องการค้นหา" value={column} onChange={event => { setColumn(event.target.value); setPage(1); }}>
          <option value="">ทุกคอลัมน์</option>
          {sheet.columns.map(item => <option value={item.key} key={item.key}>{item.name}</option>)}
        </select>
      </label>
      <span className="data-table-count">{count(sheet.rows_count)} แถว · {sheet.columns.length} คอลัมน์</span>
    </div>
    {error ? <div className="data-inline-error" role="alert"><p>{error}</p><button className="data-button secondary" onClick={() => setRetry(value => value + 1)}>ลองโหลดอีกครั้ง</button></div> :
      // This scroll region must be keyboard-focusable so wide tables can be scrolled.
      // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      <section className="data-table-scroll" tabIndex={0} aria-label={`ตาราง ${sheet.name} เลื่อนแนวนอนเพื่อดูคอลัมน์เพิ่มเติม`} aria-busy={busy}>
        <table>
          <thead><tr><th className="data-row-number" scope="col">แถวต้นฉบับ</th>{sheet.columns.map(item => <th key={item.key} scope="col" aria-sort={sort === item.key ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
            <button onClick={() => changeSort(item.key)} aria-label={`เรียงตาม ${item.name}`}>
              <span><strong>{item.name}</strong><small>{typeLabels[item.data_type] || item.data_type}</small></span>
              {sort !== item.key ? <ArrowUpDown size={14} /> : direction === 'asc' ? <ArrowUp size={14} /> : <ArrowDown size={14} />}
            </button>
          </th>)}</tr></thead>
          <tbody>{!busy && data?.rows.length ? data.rows.map(row => <tr key={row.row_number}>
            <td className="data-row-number">{count(row.row_number)}</td>
            {sheet.columns.map(item => {
              const value = row.values[item.key];
              const label = value === null || value === undefined ? null : String(value);
              return <td key={item.key} className={item.data_type === 'number' ? 'numeric' : undefined} title={label ?? 'ค่าว่าง'}>{label ?? <span className="data-null">—</span>}</td>;
            })}
          </tr>) : <tr><td colSpan={sheet.columns.length + 1} className="data-table-empty">{busy ? 'กำลังโหลดข้อมูล…' : 'ไม่พบข้อมูลที่ตรงกับการค้นหา'}</td></tr>}</tbody>
        </table>
      </section>}
    {!busy && data && data.truncated_cells > 0 && <p className="data-preview-limit">ข้อความยาว {count(data.truncated_cells)} เซลล์ในหน้านี้แสดงไม่เกิน {count(data.max_cell_characters)} ตัวอักษรต่อเซลล์ · การค้นหาและเรียงข้อมูลยังใช้ข้อความเต็ม</p>}
    <div className="data-pagination">
      <span aria-live="polite">{busy ? 'กำลังโหลด…' : data ? `${count(data.total_rows)} แถว${search ? 'ที่ตรงกับการค้นหา' : 'ทั้งหมด'} · หน้า ${page} จาก ${pages}` : 'ยังโหลดข้อมูลไม่ได้'}</span>
      <div>
        <label className="data-select-label">แถวต่อหน้า<select aria-label="แถวต่อหน้า" value={pageSize} onChange={event => { setPageSize(Number(event.target.value)); setPage(1); }}>
          {[25, 50, 100].map(size => <option key={size} value={size}>{size}</option>)}
        </select></label>
        <button className="data-icon-button" aria-label="หน้าก่อนหน้า" disabled={busy || page === 1} onClick={() => setPage(value => value - 1)}><ChevronLeft size={19} /></button>
        <button className="data-icon-button" aria-label="หน้าถัดไป" disabled={busy || !data || page >= pages} onClick={() => setPage(value => value + 1)}><ChevronRight size={19} /></button>
      </div>
    </div>
  </section>;
}
