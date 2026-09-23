import type { Metadata } from 'next';
import './globals.css';
import './analyst.css';
import './insights.css';
export const metadata: Metadata = {
  title: 'AI Data Analyst | Turn Excel & CSV into Business Reports',
  description: 'Upload your CSV or Excel file and let AI turn it into an understandable executive business report and interactive dashboard.',
};
export default function RootLayout({children}:Readonly<{children:React.ReactNode}>){return <html lang="th"><body>{children}</body></html>}
