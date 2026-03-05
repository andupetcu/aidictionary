import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const termsPath = join(__dirname, '..', 'src', 'content', 'en', 'terms.json');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL environment variable is required');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL });

async function seed() {
  const client = await pool.connect();

  try {
    // Create table and indexes
    await client.query(`
      CREATE TABLE IF NOT EXISTS terms (
        id SERIAL PRIMARY KEY,
        term TEXT NOT NULL UNIQUE,
        slug TEXT NOT NULL,
        letter CHAR(1) NOT NULL,
        category TEXT NOT NULL,
        definition TEXT NOT NULL,
        see_also TEXT[] DEFAULT '{}',
        related_terms TEXT[] DEFAULT '{}',
        examples TEXT[] DEFAULT '{}',
        source TEXT DEFAULT 'manual',
        source_url TEXT,
        approved BOOLEAN DEFAULT true,
        arxiv_id TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      ALTER TABLE terms ADD COLUMN IF NOT EXISTS related_terms TEXT[] DEFAULT '{}';
      ALTER TABLE terms ADD COLUMN IF NOT EXISTS examples TEXT[] DEFAULT '{}';
      ALTER TABLE terms ADD COLUMN IF NOT EXISTS source_url TEXT;
      CREATE INDEX IF NOT EXISTS idx_terms_letter ON terms(letter);
      CREATE INDEX IF NOT EXISTS idx_terms_category ON terms(category);
      CREATE INDEX IF NOT EXISTS idx_terms_slug ON terms(slug);
      CREATE INDEX IF NOT EXISTS idx_terms_search ON terms USING gin(to_tsvector('english', term || ' ' || definition));
    `);
    console.log('Table and indexes created.');

    // Read terms.json
    const raw = readFileSync(termsPath, 'utf-8');
    const data = JSON.parse(raw);

    let total = 0;
    let inserted = 0;
    let skipped = 0;

    for (const [letter, terms] of Object.entries(data)) {
      for (const t of terms) {
        total++;
        const slug = t.term.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        const termLetter = /^[a-z]/i.test(t.term) ? t.term[0].toUpperCase() : '#';
        const seeAlso = Array.isArray(t.seeAlso) ? t.seeAlso : [];

        try {
          await client.query(
            `INSERT INTO terms (term, slug, letter, category, definition, see_also, source, approved)
             VALUES ($1, $2, $3, $4, $5, $6, 'manual', true)
             ON CONFLICT (term) DO UPDATE SET
               slug = EXCLUDED.slug,
               letter = EXCLUDED.letter,
               category = EXCLUDED.category,
               definition = EXCLUDED.definition,
               see_also = EXCLUDED.see_also,
               updated_at = NOW()`,
            [t.term, slug, termLetter, t.category, t.definition, seeAlso]
          );
          inserted++;
        } catch (err) {
          console.error(`Failed to insert "${t.term}":`, err.message);
          skipped++;
        }
      }
    }

    console.log(`Done. Total: ${total}, Inserted/Updated: ${inserted}, Skipped: ${skipped}`);
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
