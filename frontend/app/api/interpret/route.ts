import { backendProxy } from '@/lib/backend-proxy';
export function GET(request: Request) { return backendProxy(request, '/api/interpret'); }
export function POST(request: Request) { return backendProxy(request, '/api/interpret'); }
