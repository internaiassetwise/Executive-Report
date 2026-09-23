import { datasetProxy } from '@/lib/dataset-proxy';
// Same transport as datasets: the backend owns the password check and cookie.
export const GET = datasetProxy;
export const POST = datasetProxy;
export const DELETE = datasetProxy;
