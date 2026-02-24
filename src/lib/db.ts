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
    `SELECT term, slug, letter, category, definition, see_also, source
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
  }));
}

export async function insertTerm(term: {
  term: string;
  category: string;
  definition: string;
  seeAlso: string[];
  source: string;
  approved: boolean;
}) {
  const slug = term.term.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const letter = /^[a-z]/i.test(term.term) ? term.term[0].toUpperCase() : '#';

  const { rows } = await query(
    `INSERT INTO terms (term, slug, letter, category, definition, see_also, source, approved)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (term) DO UPDATE SET
       definition = EXCLUDED.definition,
       category = EXCLUDED.category,
       see_also = EXCLUDED.see_also,
       updated_at = NOW()
     RETURNING *`,
    [term.term, slug, letter, term.category, term.definition, term.seeAlso, term.source, term.approved]
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

export default pool;
