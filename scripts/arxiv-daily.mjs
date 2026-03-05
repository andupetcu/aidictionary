#!/usr/bin/env node

/**
 * ArXiv daily scrape + auto-import for aidictionary.dev
 * 
 * Runs the arxiv scraper, then pushes results to the import API.
 * Designed to be called by OpenClaw cron.
 * 
 * Usage:
 *   IMPORT_SECRET=xxx node scripts/arxiv-daily.mjs [--dry-run]
 * 
 * Env:
 *   IMPORT_SECRET — auth token for /api/import.json
 *   API_BASE — site URL (default: https://aidictionary.dev)
 *   DATABASE_URL — direct DB import fallback
 */

import { execSync } from 'child_process';
import { readFileSync, existsSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_FILE = join(__dirname, '..', 'arxiv-daily-output.json');
const IMPORT_SECRET = process.env.IMPORT_SECRET || '';
const API_BASE = process.env.API_BASE || 'https://aidictionary.dev';
const DATABASE_URL = process.env.DATABASE_URL || '';
const dryRun = process.argv.includes('--dry-run');

async function main() {
  console.log(`[arxiv-daily] Starting daily ArXiv scrape — ${new Date().toISOString()}`);

  // Step 1: Run the scraper (limit to recent papers)
  try {
    console.log('[arxiv-daily] Running arxiv-scraper...');
    execSync(
      `node ${join(__dirname, 'arxiv-scraper.mjs')} --max-papers 500 --output ${OUTPUT_FILE}`,
      { stdio: 'inherit', timeout: 300000 } // 5 min timeout
    );
  } catch (e) {
    console.error('[arxiv-daily] Scraper failed:', e.message);
    process.exit(1);
  }

  // Step 2: Read output
  if (!existsSync(OUTPUT_FILE)) {
    console.log('[arxiv-daily] No output file — scraper produced no results');
    return;
  }

  const raw = JSON.parse(readFileSync(OUTPUT_FILE, 'utf-8'));
  const terms = [];
  for (const batch of Object.values(raw)) {
    if (Array.isArray(batch)) terms.push(...batch);
  }
  console.log(`[arxiv-daily] Scraped ${terms.length} concepts`);

  if (terms.length === 0) {
    console.log('[arxiv-daily] No new concepts. Done.');
    return;
  }

  if (dryRun) {
    console.log(`[arxiv-daily] Dry run — would import ${terms.length} terms`);
    console.log(`[arxiv-daily] Sample:`, terms.slice(0, 3).map(t => t.term));
    return;
  }

  // Step 3: Import via API or direct DB
  let result;

  if (IMPORT_SECRET) {
    console.log(`[arxiv-daily] Pushing to ${API_BASE}/api/import.json...`);
    const res = await fetch(`${API_BASE}/api/import.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${IMPORT_SECRET}`,
      },
      body: JSON.stringify(terms),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`[arxiv-daily] API import failed: ${res.status} ${err}`);
      process.exit(1);
    }

    result = await res.json();
  } else if (DATABASE_URL) {
    console.log('[arxiv-daily] No IMPORT_SECRET, using direct DB import...');
    execSync(
      `DATABASE_URL="${DATABASE_URL}" node ${join(__dirname, 'merge-arxiv.mjs')}`,
      { stdio: 'inherit', timeout: 120000, env: { ...process.env, DATABASE_URL } }
    );
    result = { success: true, inserted: terms.length, note: 'direct DB' };
  } else {
    console.error('[arxiv-daily] No IMPORT_SECRET or DATABASE_URL — cannot import');
    process.exit(1);
  }

  console.log(`[arxiv-daily] Import result:`, result);

  // Cleanup daily output
  try { unlinkSync(OUTPUT_FILE); } catch {}

  console.log(`[arxiv-daily] Done!`);
}

main().catch(e => { console.error('[arxiv-daily] Fatal:', e); process.exit(1); });
