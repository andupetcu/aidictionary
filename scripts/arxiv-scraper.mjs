#!/usr/bin/env node

import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  callGPT,
  chunk,
  dedup,
  ENV,
  getExistingTermsFromDB,
  parseJSONArray,
  pushToAPI,
  sleep,
  writeDataFile,
} from './lib/shared.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ALL_SECTIONS = [
  'cs.AI', 'cs.LG', 'cs.CL', 'cs.CV', 'cs.NE', 'cs.MA', 'cs.IR',
  'cs.DC', 'cs.SE', 'cs.PL', 'cs.OS', 'cs.AR', 'cs.DB', 'cs.NI',
  'cs.CR', 'cs.CC', 'cs.DS', 'cs.IT', 'cs.LO', 'cs.HC', 'cs.MM',
  'cs.SD', 'cs.RO', 'cs.GR', 'stat.ML', 'eess.SP', 'eess.AS', 'math.OC',
  'q-fin.CP', 'econ.GN',
];

const CATEGORY_MAP = {
  'cs.AI': 'AI/ML', 'cs.LG': 'AI/ML', 'cs.CL': 'AI/ML', 'cs.CV': 'AI/ML', 'cs.NE': 'AI/ML',
  'cs.MA': 'AI/ML', 'stat.ML': 'AI/ML', 'math.OC': 'AI/ML', 'cs.IR': 'Data Science',
  'cs.DC': 'Cloud', 'cs.SE': 'Programming', 'cs.PL': 'Programming', 'cs.DS': 'Programming', 'cs.LO': 'Programming',
  'cs.OS': 'DevOps', 'cs.CR': 'Cybersecurity', 'cs.DB': 'Data Science',
  'q-fin.CP': 'Business', 'econ.GN': 'Business', 'cs.HC': 'UX/UI', 'cs.GR': 'Design',
};

function parseArgs() {
  const args = process.argv.slice(2);
  const cfg = {
    sections: ALL_SECTIONS,
    maxPapers: 200,
    batchSize: 10,
    delayMs: 1200,
    output: join(__dirname, '..', 'data', 'arxiv-daily.json'),
    push: true,
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--sections' && args[i + 1]) cfg.sections = args[++i].split(',').map((s) => s.trim()).filter(Boolean);
    if (args[i] === '--max-papers' && args[i + 1]) cfg.maxPapers = Number(args[++i]) || cfg.maxPapers;
    if (args[i] === '--batch-size' && args[i + 1]) cfg.batchSize = Number(args[++i]) || cfg.batchSize;
    if (args[i] === '--delay' && args[i + 1]) cfg.delayMs = Number(args[++i]) || cfg.delayMs;
    if (args[i] === '--output' && args[i + 1]) cfg.output = args[++i];
    if (args[i] === '--dry-run') cfg.dryRun = true;
    if (args[i] === '--no-push') cfg.push = false;
  }

  return cfg;
}

function extractTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return match ? match[1].trim() : null;
}

function parseAtomFeed(xml, section) {
  const entries = xml.split('<entry>').slice(1);
  return entries
    .map((entry) => {
      const title = extractTag(entry, 'title')?.replace(/\s+/g, ' ').trim();
      const abstract = extractTag(entry, 'summary')?.replace(/\s+/g, ' ').trim();
      const id = extractTag(entry, 'id')?.replace('http://arxiv.org/abs/', '').trim();
      if (!title || !abstract || !id) return null;
      return {
        title,
        abstract: abstract.slice(0, 1600),
        arxivId: id,
        section,
        source_url: `https://arxiv.org/abs/${id}`,
      };
    })
    .filter(Boolean);
}

async function fetchArxivPapers(section, maxResults) {
  const url = `http://export.arxiv.org/api/query?search_query=cat:${section}&start=0&max_results=${maxResults}&sortBy=submittedDate&sortOrder=descending`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'aidictionary-bot/1.0 (https://aidictionary.dev)' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return parseAtomFeed(await res.text(), section);
}

function buildPrompt(batch, existingTerms) {
  const paperList = batch.map((p, i) =>
    `[${i + 1}] ${p.title}\nSection: ${p.section}\nArXiv: ${p.arxivId}\nAbstract: ${p.abstract}`
  ).join('\n\n');

  return `You are a technical lexicographer building an AI/tech dictionary. Extract notable concepts from these ArXiv papers.

PAPERS:
${paperList}

TERMS TO SKIP (already present):
${existingTerms.slice(0, 300).join(', ')}

RULES:
1. Extract only genuinely useful technical terms (architectures, methods, benchmarks, datasets, frameworks).
2. Skip generic terms or marketing names.
3. Keep definition concise (1-3 sentences).
4. Add 1-2 usage examples copied/paraphrased from the abstract context where the term appears.
5. Choose category from: AI/ML, Programming, Cybersecurity, Cloud, Data Science, DevOps, Design, UX/UI, Technology, Business, Web.
6. Include paper URL and arXiv id when available.

Return JSON array only:
[
  {
    "term": "Term",
    "category": "AI/ML",
    "definition": "Definition...",
    "seeAlso": ["Term A", "Term B"],
    "examples": ["Sentence using the term.", "Second usage sentence."],
    "arxivId": "2401.12345",
    "source_url": "https://arxiv.org/abs/2401.12345"
  }
]`;
}

async function extractFromBatch(batch, existingTerms) {
  const content = await callGPT(buildPrompt(batch, existingTerms), {
    systemPrompt: 'Output valid JSON array only. Do not wrap in markdown.',
    temperature: 0.2,
    maxTokens: 4000,
  });

  const parsed = parseJSONArray(content);
  return parsed.map((item) => {
    const sourcePaper = batch.find((p) => p.arxivId === item.arxivId) || batch[0];
    return {
      ...item,
      category: item.category || CATEGORY_MAP[sourcePaper?.section] || 'Technology',
      source: 'arxiv',
      source_url: item.source_url || sourcePaper?.source_url || null,
      arxivId: item.arxivId || sourcePaper?.arxivId || null,
      examples: Array.isArray(item.examples) ? item.examples.slice(0, 2) : [],
    };
  });
}

async function main() {
  const cfg = parseArgs();
  console.log(`[arxiv] Sections=${cfg.sections.length} maxPapers=${cfg.maxPapers} dryRun=${cfg.dryRun}`);

  const existingTerms = await getExistingTermsFromDB().catch(() => []);
  const allPapers = [];

  for (const section of cfg.sections) {
    try {
      const papers = await fetchArxivPapers(section, cfg.maxPapers);
      allPapers.push(...papers);
      console.log(`[arxiv] ${section}: ${papers.length} papers`);
    } catch (err) {
      console.error(`[arxiv] ${section} failed: ${err.message}`);
    }
    await sleep(cfg.delayMs);
  }

  const batches = chunk(allPapers, cfg.batchSize);
  const extracted = [];
  for (let i = 0; i < batches.length; i++) {
    try {
      const terms = await extractFromBatch(batches[i], [...existingTerms, ...extracted.map((t) => t.term.toLowerCase())]);
      extracted.push(...terms);
      console.log(`[arxiv] Batch ${i + 1}/${batches.length}: +${terms.length}`);
    } catch (err) {
      console.error(`[arxiv] Batch ${i + 1} failed: ${err.message}`);
    }
    await sleep(1000);
  }

  const unique = dedup(extracted, existingTerms);

  const byLetter = {};
  for (const t of unique) {
    const letter = /^[a-z]/i.test(t.term) ? t.term[0].toUpperCase() : '#';
    byLetter[letter] ||= [];
    byLetter[letter].push(t);
  }

  writeFileSync(cfg.output, JSON.stringify(byLetter, null, 2));
  writeDataFile('arxiv-daily.json', byLetter);
  console.log(`[arxiv] Extracted ${unique.length} unique terms`);

  if (cfg.push) {
    try {
      const result = await pushToAPI(unique, { dryRun: cfg.dryRun, label: 'arxiv' });
      console.log(`[arxiv] Import result: ${JSON.stringify(result)}`);
    } catch (err) {
      console.error(`[arxiv] Import failed: ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error('[arxiv] Fatal:', err);
  process.exit(1);
});
