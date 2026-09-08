import { defineRailway, github, preserve, project, service } from 'railway/iac';

const repository = 'internaiassetwise/Executive-Report';
const source = () => github(repository, { branch: 'main' });

export default defineRailway(() => {
  const backend = service('backend', {
    source: source(),
    build: {
      builder: 'RAILPACK',
      buildCommand: 'npm run build:backend',
      watchPatterns: ['/backend/**', '/package.json', '/package-lock.json'],
    },
    start: 'npm run start:backend',
    healthcheck: '/api/health',
    healthcheckTimeout: 300,
    deploy: {
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 10,
      overlapSeconds: 30,
      drainingSeconds: 10,
    },
    env: {
      NODE_ENV: 'production',
      FRONTEND_ORIGINS: {
        value: 'https://${{frontend.RAILWAY_PUBLIC_DOMAIN}}',
        description: 'Allowed browser origin for the frontend proxy.',
      },
      GEMINI_API_KEY: preserve(),
      GEMINI_MODEL: preserve(),
    },
  });

  const frontend = service('frontend', {
    source: source(),
    build: {
      builder: 'RAILPACK',
      buildCommand: 'npm run build',
      watchPatterns: ['/frontend/**', '/package.json', '/package-lock.json'],
    },
    start: 'npm run start:frontend',
    healthcheck: '/',
    healthcheckTimeout: 300,
    deploy: {
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 10,
      overlapSeconds: 30,
      drainingSeconds: 10,
    },
    env: {
      NODE_ENV: 'production',
      VINEXT_TRUST_PROXY: {
        value: '1',
        description: 'Honor Railway forwarding headers for same-origin POST checks.',
      },
      BACKEND_URL: {
        value: 'http://${{backend.RAILWAY_PRIVATE_DOMAIN}}:${{backend.PORT}}',
        description: 'Private Railway URL for server-side API proxying.',
      },
    },
  });

  return project('Executive Report', {
    resources: [frontend, backend],
  });
});
