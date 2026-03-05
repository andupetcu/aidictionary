#!/usr/bin/env node

import { spawnSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dryRun = process.argv.includes('--dry-run');

async function main() {
  const args = [join(__dirname, 'scrape-all.mjs'), '--sources=arxiv,hf,github,blogs'];
  if (dryRun) args.push('--dry-run');

  console.log(`[arxiv-daily] Running unified scraper at ${new Date().toISOString()}`);
  const proc = spawnSync('node', args, {
    stdio: 'inherit',
    env: process.env,
    timeout: 45 * 60 * 1000,
  });

  if (proc.status !== 0) {
    console.error(`[arxiv-daily] scrape-all failed with code ${proc.status}`);
    process.exit(proc.status || 1);
  }

  console.log('[arxiv-daily] Done');
}

main().catch((err) => {
  console.error('[arxiv-daily] Fatal:', err);
  process.exit(1);
});
