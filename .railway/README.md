# Railway deployment

โปรเจกต์นี้ deploy เป็น 2 services จาก GitHub repository เดียวกัน:

- `frontend`: Vinext production server มี public domain และส่งคำขอ API ผ่าน route handlers
- `backend`: Node API อยู่ใน Railway private network และเปิด healthcheck ที่ `/api/health` build จาก `backend/Dockerfile` เพราะ API เรียก Python workers (อ่าน Excel, วิเคราะห์, PDF) image จึงมี Node, Python + `backend/requirements.txt` และฟอนต์ Noto Sans Thai ในตัว ไม่ต้องตั้งค่า Python ใน dashboard

ไฟล์ `.railway/railway.ts` ใช้ Railway Infrastructure as Code รุ่นปัจจุบัน แทน `railway.json` หรือ `railway.toml` ที่เลิกใช้แล้ว ทั้งสอง services ใช้ repo root เพื่อให้ `npm ci` อ่าน workspace lockfile ชุดเดียวกัน

## ก่อน apply

1. Commit และ push โค้ดที่ต้องการ deploy ไปที่ branch `main` ของ `internaiassetwise/Executive-Report`
2. ติดตั้ง Railway CLI รุ่น 5.42.1 ขึ้นไป (Windows ติดตั้งผ่าน npm ได้):

   ```powershell
   npm i -g @railway/cli
   railway --version
   ```

   โปรเจกต์มี Railway TypeScript SDK สำหรับอ่าน `.railway/railway.ts` อยู่แล้ว ส่วน CLI เป็นเครื่องมือของเครื่องผู้ deploy
3. ให้ Railway workspace เข้าถึง GitHub repository `internaiassetwise/Executive-Report` แล้วเชื่อมบัญชีกับ project/environment หากยังไม่มี project ให้ใช้ `railway init --name "Executive Report"` แทน `railway link`:

   ```powershell
   railway login
   railway link
   ```

   ข้อมูล link เฉพาะเครื่องใน `.railway/` ถูก ignore ไว้ เหลือเฉพาะ IaC และคู่มือนี้ที่เข้า Git

4. ตรวจแผนก่อนสร้างหรือแก้ infrastructure:

   ```powershell
   railway config plan
   ```

5. เมื่อแผนถูกต้องจึง apply:

   ```powershell
   railway config apply
   ```

## หลัง apply ครั้งแรก

1. สร้าง Railway public domain ให้ service `frontend` จากหน้า Networking ส่วน `backend` ใช้ private network และไม่ต้องมี public domain
2. Railway reference variables ใน IaC จะเชื่อมสอง services ดังนี้:
   - `frontend.BACKEND_URL` → `http://${{backend.RAILWAY_PRIVATE_DOMAIN}}:${{backend.PORT}}`
   - `backend.FRONTEND_ORIGINS` → `https://${{frontend.RAILWAY_PUBLIC_DOMAIN}}`
   - `frontend.VINEXT_TRUST_PROXY=1` → ให้ same-origin check อ่าน HTTPS forwarding headers ของ Railway ถูกต้อง
3. หากเปิดใช้ Gemini ให้เพิ่ม `GEMINI_API_KEY` และ `GEMINI_MODEL` ที่ Variables ของ `backend` แล้ว seal ค่า API key
4. หากเพิ่ม custom domain ให้แก้ค่า `FRONTEND_ORIGINS` ใน `.railway/railway.ts` โดยต่อ `https://your-domain.example` ด้วย comma แล้ว plan/apply อีกครั้ง เพื่อไม่ให้ค่าใน dashboard ถูก IaC เขียนทับ

## ตรวจหลัง deploy

- เปิด `/` จาก public domain ของ frontend ต้องได้ HTTP 200
- Backend deployment ต้องผ่าน healthcheck `/api/health` และ build log ต้องมีขั้น `pip install -r backend/requirements.txt`
- เปิด `/api/datasets/config` ผ่าน frontend ต้องได้ JSON (401 = ยังต้องใส่รหัส ดู `ACCESS_PASSWORD` / `ACCESS_OPEN`)
- อัปโหลดไฟล์ Excel เล็กๆ ต้องได้แดชบอร์ด ถ้าขึ้น "ไม่สามารถเริ่มตัวประมวลผล Python ได้" แปลว่า backend ไม่ได้ build จาก Dockerfile
- ดาวน์โหลด PDF ต้องเห็นตัวอักษรไทย

Variables ของ `backend`: `GEMINI_API_KEY` (seal), `GEMINI_MODEL=gemini-3-flash-preview`, `AI_DAILY_REQUEST_LIMIT` และ `ACCESS_PASSWORD` หรือ `ACCESS_OPEN=true` ถ้าไม่ต้องการรหัสผ่าน

ไฟล์ที่อัปโหลดเก็บชั่วคราวบน disk ของ backend (ลบเองตาม `DATASET_RETENTION_MINUTES`) และงานอยู่ในหน่วยความจำของ instance เดียว จึงตั้ง backend ไว้ 1 replica ไม่ต้องใช้ database หรือ volume การ redeploy ทำให้งานที่ค้างอยู่หายและต้องอัปโหลดใหม่
