import type { APIRoute } from 'astro';
import { query } from '../../lib/db';

const IMPORT_SECRET = import.meta.env.IMPORT_SECRET || process.env.IMPORT_SECRET || '';

function escapeRegex(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function rebuildRelatedTerms() {
  const { rows } = await query(
    'SELECT id, term, definition, see_also FROM terms WHERE approved = true'
  );

  const byLower = new Map<string, string>(rows.map((r: any) => [String(r.term).toLowerCase(), r.term]));
  const entries = rows
    .map((r: any) => ({ term: String(r.term), lower: String(r.term).toLowerCase() }))
    .sort((a: any, b: any) => b.term.length - a.term.length);
  const related = new Map<string, Set<string>>(rows.map((r: any) => [r.term, new Set()]));

  for (const row of rows as any[]) {
    const definition = String(row.definition || '').toLowerCase();
    const ownLower = String(row.term).toLowerCase();

    for (const entry of entries) {
      if (entry.lower === ownLower || entry.term.length < 3) continue;
      if (new RegExp(`\\b${escapeRegex(entry.lower)}\\b`, 'i').test(definition)) {
        const target = byLower.get(entry.lower);
        if (!target || target === row.term) continue;
        related.get(row.term)?.add(target);
        related.get(target)?.add(row.term);
      }
    }

    for (const see of row.see_also || []) {
      const target = byLower.get(String(see).toLowerCase());
      if (!target || target === row.term) continue;
      related.get(row.term)?.add(target);
      related.get(target)?.add(row.term);
    }
  }

  for (const row of rows as any[]) {
    await query('UPDATE terms SET related_terms = $1::text[], updated_at = NOW() WHERE id = $2', [
      [...(related.get(row.term) || new Set())].sort((a, b) => a.localeCompare(b)),
      row.id,
    ]);
  }
}

export const POST: APIRoute = async ({ request }) => {
  // Auth check
  const authHeader = request.headers.get('authorization');
  const token = authHeader?.replace('Bearer ', '');
  if (!IMPORT_SECRET || token !== IMPORT_SECRET) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  try {
    const body = await request.json();
    const terms = Array.isArray(body) ? body : body.terms;

    if (!Array.isArray(terms) || terms.length === 0) {
      return new Response(JSON.stringify({ error: 'Expected array of terms' }), { status: 400 });
    }

    // Validate and score each term
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    let failed = 0;

    for (const t of terms) {
      if (!t.term || !t.definition || !t.category) {
        skipped++;
        continue;
      }

      // Quality filter
      if (t.definition.length < 30) { skipped++; continue; }
      if (t.term.length > 80) { skipped++; continue; }
      if (/^(this paper|a paper|in this|we propose|we present)/i.test(t.definition)) { skipped++; continue; }

      const slug = t.term.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      const letter = /^[a-z]/i.test(t.term) ? t.term[0].toUpperCase() : '#';
      const seeAlso = Array.isArray(t.seeAlso) ? t.seeAlso : Array.isArray(t.see_also) ? t.see_also : [];
      const examples = Array.isArray(t.examples) ? t.examples.slice(0, 2).filter((x: any) => typeof x === 'string') : [];
      const relatedTerms = Array.isArray(t.related_terms)
        ? t.related_terms.filter((x: any) => typeof x === 'string')
        : Array.isArray(t.relatedTerms)
          ? t.relatedTerms.filter((x: any) => typeof x === 'string')
          : [];
      const sourceUrl = typeof t.source_url === 'string' ? t.source_url : typeof t.sourceUrl === 'string' ? t.sourceUrl : null;

      try {
        const { rows } = await query(
          `INSERT INTO terms (term, slug, letter, category, definition, see_also, source, approved, arxiv_id, examples, related_terms, source_url)
           VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $9, $10, $11)
           ON CONFLICT (term) DO UPDATE SET
             definition = CASE WHEN LENGTH(EXCLUDED.definition) > LENGTH(terms.definition) THEN EXCLUDED.definition ELSE terms.definition END,
             see_also = ARRAY(SELECT DISTINCT unnest(terms.see_also || EXCLUDED.see_also)),
             examples = ARRAY(SELECT DISTINCT unnest(terms.examples || EXCLUDED.examples)),
             related_terms = ARRAY(SELECT DISTINCT unnest(terms.related_terms || EXCLUDED.related_terms)),
             source_url = COALESCE(EXCLUDED.source_url, terms.source_url),
             arxiv_id = COALESCE(EXCLUDED.arxiv_id, terms.arxiv_id),
             updated_at = NOW()
           RETURNING (xmax = 0) AS is_new`,
          [t.term, slug, letter, t.category, t.definition, seeAlso, t.source || 'arxiv', t.arxivId || null, examples, relatedTerms, sourceUrl]
        );
        if (rows[0]?.is_new) inserted++;
        else updated++;
      } catch {
        failed++;
      }
    }

    let relationRebuild = 'ok';
    try {
      await rebuildRelatedTerms();
    } catch (e) {
      relationRebuild = `failed: ${(e as Error).message}`;
    }

    const { rows } = await query('SELECT COUNT(*) as total FROM terms WHERE approved = true');

    return new Response(JSON.stringify({
      success: true,
      inserted,
      updated,
      skipped,
      failed,
      relationRebuild,
      totalTerms: parseInt(rows[0].total),
    }), { status: 200 });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Import failed', message: (e as Error).message }), { status: 500 });
  }
};
