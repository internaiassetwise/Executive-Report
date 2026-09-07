import type { Metadata } from 'next';
import './globals.css';
import './workspace.css';
export const metadata: Metadata = {title:'ASW Data Insight | Excel Analysis & Reports',description:'วิเคราะห์ข้อมูล Excel ตรวจสอบคุณภาพข้อมูล และสร้างรายงานที่ตรวจสอบหลักฐานได้'};
export default function RootLayout({children}:Readonly<{children:React.ReactNode}>){return <html lang="th"><body>{children}</body></html>}
