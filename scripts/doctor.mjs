#!/usr/bin/env node
import 'dotenv/config';
import { existsSync } from 'node:fs';

const checks = [
  ['Built server', existsSync(new URL('../dist/index.js', import.meta.url))],
  ['Jules API key configured', Boolean(process.env.JULES_API_KEY && !/^(your_|offline-|dummy)/i.test(process.env.JULES_API_KEY))],
  ['Repository allowlist configured', Boolean(process.env.JULES_ALLOWED_REPOS?.split(',').some((repo) => repo.trim()))],
  ['Separate storage encryption key configured', Boolean(process.env.JULES_ENCRYPTION_KEY && !/^your_/i.test(process.env.JULES_ENCRYPTION_KEY))],
];
for (const [label, passed] of checks) console.log(`${passed ? 'PASS' : 'MISSING'}: ${label}`);
if (checks.some(([, passed]) => !passed)) process.exitCode = 1;

if (process.argv.includes('--live') && !process.exitCode) {
  // Read-only authentication check; never creates a session or prints key values.
  try {
    const { JulesClient } = await import('../dist/api/jules-client.js');
    const result = await new JulesClient().listSources(100);
    const allowed = process.env.JULES_ALLOWED_REPOS.split(',').map((repo) => repo.trim().toLowerCase()).filter(Boolean);
    const connected = new Set((result.sources ?? []).filter((source) => source.githubRepo).map((source) => `${source.githubRepo.owner}/${source.githubRepo.repo}`.toLowerCase()));
    const matches = allowed.filter((repo) => connected.has(repo));
    console.log(`PASS: Jules authentication; ${matches.length}/${allowed.length} allowed repositories found on the first source page.`);
    if (result.nextPageToken) console.log('MORE PAGES: use list_sources with nextPageToken to verify remaining repositories.');
    if (matches.length !== allowed.length) process.exitCode = 1;
  } catch {
    console.error('FAIL: Jules read-only authentication check. Verify the configured key, network and connected repositories.');
    process.exitCode = 1;
  }
}
