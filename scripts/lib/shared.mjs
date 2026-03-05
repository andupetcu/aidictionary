import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

export const ENV = {
  AZURE_ENDPOINT: process.env.AZURE_ENDPOINT || 'https://footprints-ai.openai.azure.com',
  AZURE_API_KEY: process.env.AZURE_API_KEY || '',
  AZURE_MODEL: process.env.AZURE_MODEL || 'gpt-4o-mini',
  AZURE_API_VERSION: process.env.AZURE_API_VERSION || '2025-01-01-preview',
  IMPORT_SECRET: process.env.IMPORT_SECRET || '',
  API_BASE: process.env.API_BASE || 'https://aidictionary.dev',
  DATABASE_URL: process.env.DATABASE_URL || '',
};

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function slugify(term = '') {
  return term.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

export function ensureDataDir() {
  mkdirSync(join(ROOT, 'data'), { recursive: true });
}

export function writeDataFile(filename, value) {
  ensureDataDir();
  const outputPath = join(ROOT, 'data', filename);
  writeFileSync(outputPath, JSON.stringify(value, null, 2));
  return outputPath;
}

function stripCodeFence(text = '') {
  return text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
}

export function parseJSONArray(text = '') {
  const clean = stripCodeFence(text);
  const firstBracket = clean.indexOf('[');
  const lastBracket = clean.lastIndexOf(']');
  if (firstBracket === -1 || lastBracket === -1 || lastBracket <= firstBracket) return [];
  const body = clean.slice(firstBracket, lastBracket + 1);
  try {
    const parsed = JSON.parse(body);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function callGPT(prompt, options = {}) {
  if (!ENV.AZURE_API_KEY) {
    throw new Error('AZURE_API_KEY is required for GPT extraction');
  }

  const {
    systemPrompt = 'You extract technical concepts for a developer dictionary. Output valid JSON only.',
    temperature = 0.2,
    maxTokens = 4000,
  } = options;

  const url = `${ENV.AZURE_ENDPOINT}/openai/deployments/${ENV.AZURE_MODEL}/chat/completions?api-version=${ENV.AZURE_API_VERSION}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': ENV.AZURE_API_KEY,
    },
    body: JSON.stringify({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
      temperature,
      max_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(90000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Azure OpenAI ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

function normalizeTermShape(item) {
  if (!item || typeof item !== 'object') return null;
  if (!item.term || !item.definition) return null;

  const term = String(item.term).trim();
  const definition = String(item.definition).trim();
  if (!term || !definition) return null;

  return {
    term,
    category: item.category ? String(item.category).trim() : 'Technology',
    definition,
    seeAlso: Array.isArray(item.seeAlso) ? item.seeAlso.map((v) => String(v).trim()).filter(Boolean) : [],
    related_terms: Array.isArray(item.related_terms) ? item.related_terms.map((v) => String(v).trim()).filter(Boolean) : [],
    examples: Array.isArray(item.examples) ? item.examples.map((v) => String(v).trim()).filter(Boolean).slice(0, 2) : [],
    source: item.source ? String(item.source).trim() : 'arxiv',
    source_url: item.source_url ? String(item.source_url).trim() : null,
    arxivId: item.arxivId ? String(item.arxivId).trim() : null,
  };
}

export function dedup(items, existingTerms = []) {
  const existing = new Set(existingTerms.map((t) => String(t).toLowerCase()));
  const seen = new Set(existing);
  const out = [];

  for (const raw of items || []) {
    const item = normalizeTermShape(raw);
    if (!item) continue;

    const key = item.term.toLowerCase();
    if (seen.has(key)) continue;
    if (item.term.length > 80 || item.definition.length < 30) continue;

    seen.add(key);
    out.push(item);
  }

  return out;
}

export async function getExistingTermsFromDB() {
  if (!ENV.DATABASE_URL) return [];

  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: ENV.DATABASE_URL });
  try {
    const { rows } = await pool.query('SELECT term FROM terms WHERE approved = true');
    return rows.map((r) => String(r.term).toLowerCase());
  } finally {
    await pool.end();
  }
}

export async function pushToAPI(terms, options = {}) {
  const { dryRun = false, label = 'import' } = options;
  const normalized = Array.isArray(terms) ? terms : [];

  if (dryRun) {
    return { success: true, dryRun: true, total: normalized.length };
  }

  if (!ENV.IMPORT_SECRET) {
    throw new Error('IMPORT_SECRET is required to push terms to /api/import.json');
  }

  const res = await fetch(`${ENV.API_BASE}/api/import.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ENV.IMPORT_SECRET}`,
    },
    body: JSON.stringify(normalized),
    signal: AbortSignal.timeout(60000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`[${label}] API import failed ${res.status}: ${body.slice(0, 300)}`);
  }

  return await res.json();
}

export function chunk(array, size) {
  const result = [];
  for (let i = 0; i < array.length; i += size) {
    result.push(array.slice(i, i + size));
  }
  return result;
}
