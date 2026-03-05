import pg from 'pg';

const pool = new pg.Pool({
  connectionString: import.meta.env.DATABASE_URL || process.env.DATABASE_URL,
  max: 10,
});

export async function query(text: string, params?: unknown[]) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

export async function searchTerms(q: string) {
  const { rows } = await query(
    `SELECT term, slug, letter, category, definition, see_also, source, related_terms, examples, source_url
     FROM terms
     WHERE approved = true
       AND (to_tsvector('english', term || ' ' || definition) @@ plainto_tsquery('english', $1)
            OR term ILIKE '%' || $2 || '%')
     ORDER BY ts_rank(to_tsvector('english', term || ' ' || definition), plainto_tsquery('english', $1)) DESC
     LIMIT 50`,
    [q, q]
  );
  return rows.map(r => ({
    term: r.term,
    slug: r.slug,
    letter: r.letter,
    category: r.category,
    definition: r.definition,
    seeAlso: r.see_also || [],
    source: r.source,
    relatedTerms: r.related_terms || [],
    examples: r.examples || [],
    sourceUrl: r.source_url || null,
  }));
}

export async function insertTerm(term: {
  term: string;
  category: string;
  definition: string;
  seeAlso: string[];
  relatedTerms?: string[];
  examples?: string[];
  sourceUrl?: string | null;
  source: string;
  approved: boolean;
}) {
  const slug = term.term.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const letter = /^[a-z]/i.test(term.term) ? term.term[0].toUpperCase() : '#';

  const { rows } = await query(
    `INSERT INTO terms (term, slug, letter, category, definition, see_also, source, approved, related_terms, examples, source_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (term) DO UPDATE SET
       definition = EXCLUDED.definition,
       category = EXCLUDED.category,
       see_also = EXCLUDED.see_also,
       related_terms = EXCLUDED.related_terms,
       examples = EXCLUDED.examples,
       source_url = COALESCE(EXCLUDED.source_url, terms.source_url),
       updated_at = NOW()
     RETURNING *`,
    [
      term.term,
      slug,
      letter,
      term.category,
      term.definition,
      term.seeAlso,
      term.source,
      term.approved,
      term.relatedTerms || [],
      term.examples || [],
      term.sourceUrl || null,
    ]
  );
  return rows[0];
}

export async function getTermBySlug(slug: string) {
  const { rows } = await query(
    'SELECT * FROM terms WHERE slug = $1 AND approved = true LIMIT 1',
    [slug]
  );
  return rows[0] || null;
}

export async function getTrendingTerms(limit = 20) {
  const { rows } = await query(
    `SELECT term, slug, category, source, created_at
     FROM terms
     WHERE approved = true
       AND created_at > NOW() - INTERVAL '7 days'
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function getTrendingSummary() {
  const [totalRes, sourceRes] = await Promise.all([
    query(
      `SELECT COUNT(*)::int AS total
       FROM terms
       WHERE approved = true
         AND created_at > NOW() - INTERVAL '7 days'`
    ),
    query(
      `SELECT source, COUNT(*)::int AS count
       FROM terms
       WHERE approved = true
         AND created_at > NOW() - INTERVAL '7 days'
       GROUP BY source
       ORDER BY count DESC`
    ),
  ]);
  return {
    total: totalRes.rows[0]?.total || 0,
    bySource: sourceRes.rows,
  };
}

export default pool;
