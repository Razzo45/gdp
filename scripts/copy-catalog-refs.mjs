import { spawnSync } from 'node:child_process';

/** Point worker + catchup at the web Catalog token. Never prints values. */
function setVar(service, key, value) {
  const result = spawnSync(
    'npx',
    ['--yes', '@railway/cli', 'variable', 'set', key, '--stdin', '--service', service, '--skip-deploys'],
    { input: value, encoding: 'utf8', shell: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  if (result.status !== 0) {
    throw new Error(`set ${service}.${key}: ${(result.stderr || result.stdout || '').slice(0, 300)}`);
  }
  console.log(`set ${service}.${key}`);
}

const refs = {
  WIRESTOCK_API_BASE_URL: '${{gdp.WIRESTOCK_API_BASE_URL}}',
  WIRESTOCK_API_TOKEN: '${{gdp.WIRESTOCK_API_TOKEN}}',
};

for (const service of ['worker', 'catchup']) {
  for (const [key, value] of Object.entries(refs)) setVar(service, key, value);
}
console.log('wired Catalog refs (restart worker to pick them up)');
