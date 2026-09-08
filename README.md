# ASW Data Insight

โปรเจกต์แบ่งเป็น `frontend` และ `backend` และใช้ npm workspaces จากโฟลเดอร์หลัก

```text
AI report/
├── frontend/
│   ├── app/                 หน้าเว็บและตัวส่งต่อคำขอไป backend
│   ├── components/          UI, กราฟ, ตัวอย่างรายงาน
│   ├── lib/                 โมเดลข้อมูลและตัวเชื่อมต่อ
│   ├── public/              โลโก้, ข้อมูลตัวอย่าง, Python web worker
│   ├── tests/               ทดสอบ Pyodide
│   ├── scripts/             สร้างข้อมูลตัวอย่าง
│   └── .openai/             ข้อมูลอ้างอิง Sites เฉพาะเครื่อง (ไม่เข้า Git)
├── backend/
│   ├── src/                 HTTP API และการเชื่อมต่อ Gemini
│   ├── analysis/            Python analysis engine ฉบับหลัก
│   ├── tests/               ทดสอบ API และการคำนวณ
│   ├── .env                 Gemini key และ model (ไม่เข้า Git)
│   └── .env.example         ตัวอย่างการตั้งค่า
├── scripts/dev.mjs          เปิด/ปิดทั้งสองเซิร์ฟเวอร์ร่วมกัน
├── skills/                  แนวทางพัฒนารายส่วน
├── package.json             คำสั่งรวม
└── package-lock.json        lockfile ของทั้งโปรเจกต์
```

## เปิดใช้งานบน localhost

ใช้ Node.js 22.13 ขึ้นไป จากโฟลเดอร์หลักของโปรเจกต์:

```powershell
npm install
npm run dev
```

หลัง clone สามารถเปิด localhost ได้ทันทีโดยไม่ต้องมีไฟล์ `.openai/hosting.json` หากต้องการ Gemini ให้คัดลอก `backend/.env.example` เป็น `backend/.env` แล้วตั้งค่าของคุณเอง

- หน้าเว็บ: http://localhost:3000
- Backend: http://127.0.0.1:8000
- ตรวจ backend: http://127.0.0.1:8000/api/health
- กด Ctrl+C ที่คำสั่งรวมเพื่อหยุดทั้งสองฝั่ง

หากต้องการเปิดแยก terminal: `npm run dev:backend` และ `npm run dev:frontend`

## Gemini key

ใส่ `GEMINI_API_KEY` และ `GEMINI_MODEL` ใน `backend/.env` แล้วเริ่ม backend ใหม่ ค่าจาก `.env` เดิมถูกย้ายมาโดยไม่เปลี่ยนแปลง ไม่มี Gemini key ใน frontend และไม่มีการส่ง key ให้เบราว์เซอร์

`frontend/.env.example` มีเพียง `BACKEND_URL` ซึ่งเริ่มต้นเป็น `http://127.0.0.1:8000` ไม่จำเป็นต้องสร้าง frontend `.env` หากใช้ค่าเดิม

## การประมวลผล

อัปโหลดครั้งเดียวแล้วอ่านทุกชีตอัตโนมัติ รวมชีตที่ซ่อนอยู่ แสดงภาพรวมทุกตารางโดยไม่ต้องเลือกชีต คำนวณแยกแต่ละตารางและรวมข้อค้นพบในรายงานเดียวพร้อมที่มา ชีตว่างหรือไม่มีตารางเข้าเกณฑ์จะแสดงเหตุผล ผลลัพธ์แบ่งหน้าครั้งละ 12 รายการ ส่วนรายงานและ Report JSON เก็บข้อค้นพบครบทุกตาราง

การจัดโฟลเดอร์ครั้งนี้คงพฤติกรรมเดิม: ไฟล์ Excel ยังคำนวณด้วย Python/Pyodide ในเบราว์เซอร์ ไม่ส่ง workbook ไป backend ตัว backend ให้บริการ source code ของ engine ฉบับหลักและ API สำหรับคำตีความจาก Gemini เท่านั้น

Frontend ส่ง `/api/interpret` และ `/analysis_engine.py` ผ่าน Node proxy ของ Vite ระหว่างพัฒนาบน localhost ส่วน build มี app route สำหรับเชื่อมต่อ backend ที่เข้าถึงได้ผ่าน `BACKEND_URL` ไม่ทำสำเนา Python engine ลงใน `public` การใช้ build บน Worker อาจไม่รองรับ backend แบบ loopback จึงต้องใช้ URL ของ backend ที่เผยแพร่แล้ว

## ตรวจสอบ

Git เก็บเฉพาะโค้ด เอกสาร และข้อมูลตัวอย่างที่สร้างขึ้นด้วย `frontend/scripts/create_sample.py` ไฟล์ `.env`, ข้อมูลผูก deployment, workbook ที่อัปโหลด, รายงานส่งออก และไฟล์ credentials ถูกกันด้วย `.gitignore` อย่าใช้ `git add -f` กับไฟล์เหล่านี้

```powershell
npm run typecheck
npm test
python -m pip install -r backend/requirements.txt
npm run test:analysis
npm run test:runtime
npm run build
```

การทดสอบ runtime ต้องใช้อินเทอร์เน็ตเพื่อโหลด Pyodide packages ส่วน API tests ใช้ provider จำลองและไม่เรียก Gemini ด้วย key จริง

## การเผยแพร่

โปรเจกต์เตรียมไว้สำหรับ Railway แบบ 2 services ใน private network แล้ว โดยใช้ Infrastructure as Code ที่ `.railway/railway.ts` หน้าเว็บรันด้วย `vinext start` ซึ่งอ่าน `PORT` อัตโนมัติ ส่วน backend อ่าน `PORT` และ bind ที่ `0.0.0.0`

ขั้นตอนตรวจแผน, apply, สร้าง public domain และตั้งค่า Gemini อยู่ใน [คู่มือ Railway](.railway/README.md) การ deploy จาก GitHub จะใช้เฉพาะโค้ดที่ commit และ push แล้ว
