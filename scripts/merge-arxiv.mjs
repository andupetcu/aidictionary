#!/usr/bin/env node

/**
 * Merge ArXiv concepts into the aidictionary Postgres database.
 * Reads arxiv-concepts.json, filters by quality, upserts into terms table.
 * 
 * Usage:
 *   DATABASE_URL=postgresql://... node scripts/merge-arxiv.mjs [--dry-run] [--min-quality 0.6]
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONCEPTS_FILE = join(__dirname, '..', 'arxiv-concepts.json');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const minQuality = parseFloat(args.find(a => a.startsWith('--min-quality'))?.split('=')?.[1] || '0');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL && !dryRun) {
  console.error('DATABASE_URL required (or use --dry-run)');
  process.exit(1);
}

function qualityScore(concept) {
  let score = 0.5; // base

  // Penalize very short definitions
  if (!concept.definition || concept.definition.length < 30) return 0.1;

  // Penalize very short terms (likely abbreviations without context)
  if (concept.term.length < 3) score -= 0.2;

  // Reward longer, more detailed definitions
  if (concept.definition.length > 100) score += 0.1;
  if (concept.definition.length > 200) score += 0.1;

  // Reward having seeAlso references
  if (concept.seeAlso?.length > 0) score += 0.1;

  // Reward having arxiv source
  if (concept.arxivId) score += 0.1;

  // Penalize terms that are just numbers or single common words
  if (/^\d+$/.test(concept.term)) return 0;
  if (/^(the|a|an|is|are|was|were|be|been|being)$/i.test(concept.term)) return 0;

  // Penalize terms that look like paper titles (too long)
  if (concept.term.length > 80) score -= 0.3;

  // Penalize if definition starts with "A paper" or "This paper" (scraped abstract, not definition)
  if (/^(this paper|a paper|in this|we propose|we present|we introduce)/i.test(concept.definition)) score -= 0.2;

  return Math.max(0, Math.min(1, score));
}

async function main() {
  console.log(`[merge-arxiv] Loading ${CONCEPTS_FILE}`);
  const raw = JSON.parse(readFileSync(CONCEPTS_FILE, 'utf-8'));

  // Flatten batches
  let allConcepts = [];
  for (const batch of Object.values(raw)) {
    if (Array.isArray(batch)) allConcepts.push(...batch);
  }
  console.log(`[merge-arxiv] Total concepts: ${allConcepts.length}`);

  // Quality filter
  const scored = allConcepts.map(c => ({ ...c, quality: qualityScore(c) }));
  const filtered = scored.filter(c => c.quality >= minQuality);
  const rejected = scored.length - filtered.length;
  console.log(`[merge-arxiv] After quality filter (min=${minQuality}): ${filtered.length} accepted, ${rejected} rejected`);

  if (dryRun) {
    // Show quality distribution
    const buckets = { high: 0, medium: 0, low: 0, rejected: 0 };
    scored.forEach(c => {
      if (c.quality >= 0.7) buckets.high++;
      else if (c.quality >= 0.4) buckets.medium++;
      else if (c.quality > 0) buckets.low++;
      else buckets.rejected++;
    });
    console.log(`[merge-arxiv] Quality distribution:`, buckets);
    console.log(`[merge-arxiv] Sample high quality:`, filtered.slice(0, 3).map(c => `${c.term} (${c.quality})`));
    console.log(`[merge-arxiv] Sample rejected:`, scored.filter(c => c.quality < minQuality).slice(0, 3).map(c => `${c.term} (${c.quality})`));
    console.log(`[merge-arxiv] Dry run — no DB changes.`);
    return;
  }

  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const client = await pool.connect();

  try {
    // Ensure table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS terms (
        id SERIAL PRIMARY KEY,
        term TEXT NOT NULL UNIQUE,
        slug TEXT NOT NULL,
        letter CHAR(1) NOT NULL,
        category TEXT NOT NULL,
        definition TEXT NOT NULL,
        see_also TEXT[] DEFAULT '{}',
        source TEXT DEFAULT 'manual',
        approved BOOLEAN DEFAULT true,
        arxiv_id TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    let inserted = 0, updated = 0, failed = 0;

    for (const concept of filtered) {
      const slug = concept.term.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      const letter = /^[a-z]/i.test(concept.term) ? concept.term[0].toUpperCase() : '#';
      const seeAlso = Array.isArray(concept.seeAlso) ? concept.seeAlso : [];

      try {
        const { rows } = await client.query(
          `INSERT INTO terms (term, slug, letter, category, definition, see_also, source, approved, arxiv_id)
           VALUES ($1, $2, $3, $4, $5, $6, 'arxiv', true, $7)
           ON CONFLICT (term) DO UPDATE SET
             definition = CASE WHEN LENGTH(EXCLUDED.definition) > LENGTH(terms.definition) THEN EXCLUDED.definition ELSE terms.definition END,
             see_also = ARRAY(SELECT DISTINCT unnest(terms.see_also || EXCLUDED.see_also)),
             arxiv_id = COALESCE(EXCLUDED.arxiv_id, terms.arxiv_id),
             updated_at = NOW()
           RETURNING (xmax = 0) AS is_new`,
          [concept.term, slug, letter, concept.category, concept.definition, seeAlso, concept.arxivId || null]
        );
        if (rows[0]?.is_new) inserted++;
        else updated++;
      } catch (e) {
        failed++;
        if (failed <= 5) console.error(`  Failed: ${concept.term} — ${e.message}`);
      }
    }

    console.log(`[merge-arxiv] Done: ${inserted} inserted, ${updated} updated, ${failed} failed`);

    // Show total count
    const { rows } = await client.query('SELECT COUNT(*) as cnt FROM terms WHERE approved = true');
    console.log(`[merge-arxiv] Total approved terms in DB: ${rows[0].cnt}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => { console.error('[merge-arxiv] Fatal:', e); process.exit(1); });
