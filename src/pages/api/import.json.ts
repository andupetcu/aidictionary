import type { APIRoute } from 'astro';
import { query } from '../../lib/db';

const IMPORT_SECRET = import.meta.env.IMPORT_SECRET || process.env.IMPORT_SECRET || '';

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
      const seeAlso = Array.isArray(t.seeAlso) ? t.seeAlso : [];

      try {
        const { rows } = await query(
          `INSERT INTO terms (term, slug, letter, category, definition, see_also, source, approved, arxiv_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8)
           ON CONFLICT (term) DO UPDATE SET
             definition = CASE WHEN LENGTH(EXCLUDED.definition) > LENGTH(terms.definition) THEN EXCLUDED.definition ELSE terms.definition END,
             see_also = ARRAY(SELECT DISTINCT unnest(terms.see_also || EXCLUDED.see_also)),
             arxiv_id = COALESCE(EXCLUDED.arxiv_id, terms.arxiv_id),
             updated_at = NOW()
           RETURNING (xmax = 0) AS is_new`,
          [t.term, slug, letter, t.category, t.definition, seeAlso, t.source || 'arxiv', t.arxivId || null]
        );
        if (rows[0]?.is_new) inserted++;
        else updated++;
      } catch {
        failed++;
      }
    }

    const { rows } = await query('SELECT COUNT(*) as total FROM terms WHERE approved = true');

    return new Response(JSON.stringify({
      success: true,
      inserted,
      updated,
      skipped,
      failed,
      totalTerms: parseInt(rows[0].total),
    }), { status: 200 });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Import failed', message: (e as Error).message }), { status: 500 });
  }
};
