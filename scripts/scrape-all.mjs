#!/usr/bin/env node

import { spawnSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VALID_SOURCES = ['arxiv', 'hf', 'github', 'blogs', 'wikipedia'];

function parseArgs() {
  const args = process.argv.slice(2);
  const eqArg = args.find((a) => a.startsWith('--sources='))?.split('=')[1];
  const idx = args.indexOf('--sources');
  const spacedArg = idx !== -1 ? args[idx + 1] : undefined;
  const fromArg = eqArg || spacedArg;
  const dryRun = args.includes('--dry-run');

  const sources = fromArg
    ? fromArg.split(',').map((s) => s.trim()).filter(Boolean)
    : [...VALID_SOURCES];

  return { dryRun, sources };
}

function scriptFor(source) {
  return {
    arxiv: 'arxiv-scraper.mjs',
    hf: 'hf-scraper.mjs',
    github: 'github-trending.mjs',
    blogs: 'blog-scraper.mjs',
    wikipedia: 'wikipedia-scraper.mjs',
  }[source];
}

async function main() {
  const cfg = parseArgs();
  const sources = cfg.sources.filter((s) => VALID_SOURCES.includes(s));

  console.log(`[scrape-all] Starting sources=${sources.join(',')} dryRun=${cfg.dryRun}`);

  const results = [];
  for (const source of sources) {
    const script = scriptFor(source);
    if (!script) continue;

    const cmd = ['node', join(__dirname, script)];
    if (cfg.dryRun) cmd.push('--dry-run');

    console.log(`[scrape-all] Running ${source} -> ${script}`);
    const proc = spawnSync(cmd[0], cmd.slice(1), {
      stdio: 'inherit',
      env: process.env,
      timeout: source === 'wikipedia' ? 60 * 60 * 1000 : 20 * 60 * 1000,
    });

    const ok = proc.status === 0;
    results.push({ source, ok, code: proc.status });
    if (!ok) {
      console.error(`[scrape-all] ${source} failed with code ${proc.status}`);
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`[scrape-all] Done: ${results.length - failed.length}/${results.length} succeeded`);

  if (failed.length > 0) {
    console.error(`[scrape-all] Failed sources: ${failed.map((f) => f.source).join(', ')}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[scrape-all] Fatal:', err);
  process.exit(1);
});
