import 'dotenv/config';
import { vercelConfigurationIssues } from '../../src/lib/vercel-config';

async function main() {
  // Validate the same production rules even when launched on a developer machine.
  process.env = { ...process.env, NODE_ENV: 'production' };
  const issues = vercelConfigurationIssues(process.env);
  try {
    const { getEnv } = await import('../../src/lib/env');
    getEnv();
  } catch {
    // Schema errors may include an operator-supplied value: do not echo them.
    issues.push('Production environment validation failed; review src/lib/env.ts required keys and provider settings');
  }
  if (issues.length) {
    for (const issue of issues) console.error(`FAIL: ${issue}`);
    process.exitCode = 1;
    return;
  }
  console.log('PASS: Vercel configuration shape validated. No credentials printed.');
  console.log('NOT VERIFIED: database/Redis/S3 access, migrations, AI credentials, worker scheduling, live demo.');
}
void main();
