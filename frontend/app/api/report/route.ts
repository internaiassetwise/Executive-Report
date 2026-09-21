import {backendProxy} from '@/lib/backend-proxy';
export function POST(request:Request){return backendProxy(request,'/api/report');}
