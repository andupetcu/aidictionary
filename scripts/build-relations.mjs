#!/usr/bin/env node

import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

function parseArgs() {
  const args = process.argv.slice(2);
  return { dryRun: args.includes('--dry-run') };
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildRelations(rows) {
  const byTermLower = new Map(rows.map((r) => [String(r.term).toLowerCase(), r.term]));
  const termEntries = rows
    .map((r) => ({ term: r.term, lower: String(r.term).toLowerCase() }))
    .sort((a, b) => b.term.length - a.term.length);

  const relatedMap = new Map(rows.map((r) => [r.term, new Set()]));

  for (const row of rows) {
    const definition = String(row.definition || '').toLowerCase();
    const ownLower = String(row.term).toLowerCase();

    for (const candidate of termEntries) {
      if (candidate.lower === ownLower) continue;
      if (candidate.term.length < 3) continue;

      const pattern = new RegExp(`\\b${escapeRegex(candidate.lower)}\\b`, 'i');
      if (pattern.test(definition)) {
        relatedMap.get(row.term).add(byTermLower.get(candidate.lower));
        relatedMap.get(byTermLower.get(candidate.lower)).add(row.term);
      }
    }

    for (const see of row.see_also || []) {
      const target = byTermLower.get(String(see).toLowerCase());
      if (!target || target === row.term) continue;
      relatedMap.get(row.term).add(target);
      relatedMap.get(target).add(row.term);
    }
  }

  return relatedMap;
}

async function main() {
  const cfg = parseArgs();
  const pool = new pg.Pool({ connectionString: DATABASE_URL });

  try {
    const { rows } = await pool.query(
      'SELECT id, term, definition, see_also FROM terms WHERE approved = true'
    );
    console.log(`[relations] Loaded ${rows.length} terms`);

    const relatedMap = buildRelations(rows);
    let updates = 0;

    for (const row of rows) {
      const related = [...(relatedMap.get(row.term) || new Set())].sort((a, b) => a.localeCompare(b));
      if (cfg.dryRun) continue;

      await pool.query(
        'UPDATE terms SET related_terms = $1::text[], updated_at = NOW() WHERE id = $2',
        [related, row.id]
      );
      updates++;
    }

    console.log(`[relations] Updated related_terms for ${cfg.dryRun ? 0 : updates} terms`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[relations] Fatal:', err);
  process.exit(1);
});
