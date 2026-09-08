import { sites } from '@openai/sites-vite-plugin';
import tailwindcss from '@tailwindcss/postcss';
import vinext from 'vinext';
import { defineConfig, loadEnv } from 'vite';
import { existsSync, readFileSync } from 'node:fs';

// Local deployment metadata stays outside Git. A fresh clone works on localhost
// without being linked to an existing hosted Site.
const hostingPath = new URL('./.openai/hosting.json', import.meta.url);
const hostingConfig = existsSync(hostingPath)
  ? JSON.parse(readFileSync(hostingPath, 'utf8')) as { d1: string | null; r2: string | null }
  : null;

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  '00000000-0000-4000-8000-000000000000';

const { d1 = null, r2 = null } = hostingConfig ?? {};

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === 'seatbelt';

const localBindingConfig = {
  main: 'vinext/server/fetch-handler',
  compatibility_flags: ['nodejs_compat'],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: 'site-creator-d1',
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: 'site-creator-r2',
        },
      ]
    : [],
};

export default defineConfig(async ({ mode }) => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= 'false';
  process.env.WRANGLER_LOG_PATH ??= '.wrangler/logs';
  process.env.MINIFLARE_REGISTRY_PATH ??= '.wrangler/registry';

  const { BACKEND_URL } = loadEnv(mode, process.cwd(), 'BACKEND_');
  const backendUrl = BACKEND_URL || 'http://127.0.0.1:8000';
  // Keep the default build portable for Node hosts such as Railway. The
  // Cloudflare adapter is enabled only for a workstation linked to Sites.
  const hostingPlugins = hostingConfig
    ? [
        sites(),
        (await import('@cloudflare/vite-plugin')).cloudflare({
          viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] },
          config: localBindingConfig,
        }),
      ]
    : [];

  return {
    css: { postcss: { plugins: [tailwindcss()] } },
    server: {
      strictPort: true,
      ...(isCodexSeatbeltSandbox ? { watch: { useFsEvents: false, usePolling: true } } : {}),
      // Local proxy runs in Node; Worker runtimes may restrict loopback fetches.
      // The app route adapters handle builds with a separately hosted backend.
      proxy: {
        '/api': { target: backendUrl, changeOrigin: false },
        '/analysis_engine.py': {
          target: backendUrl, changeOrigin: false,
          rewrite: () => '/api/analysis-engine',
        },
        '/boq_engine.py': {
          target: backendUrl, changeOrigin: false,
          rewrite: () => '/api/boq-engine',
        },
        '/boq_report.py': {
          target: backendUrl, changeOrigin: false,
          rewrite: () => '/api/boq-report',
        },
      },
    },
    plugins: [
      vinext(),
      ...hostingPlugins,
    ],
  };
});
