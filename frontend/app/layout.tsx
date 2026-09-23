import type { Metadata } from 'next';
import './globals.css';
import './analyst.css';
import './insights.css';
import './dashboard.css';
import './office.css';
export const metadata: Metadata = {
  title: 'ระบบสร้าง Dashboard จากข้อมูล | AssetWise',
  description: 'อัปโหลดไฟล์ Excel หรือ CSV แล้วระบบสร้างแดชบอร์ดและรายงานให้อัตโนมัติ',
};
export default function RootLayout({children}:Readonly<{children:React.ReactNode}>){return <html lang="th"><body>{children}</body></html>}
