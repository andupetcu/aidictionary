#!/usr/bin/env node

/**
 * ArXiv Concept Extractor for aidictionary.dev
 * 
 * Scrapes arxiv.org RSS/Atom feeds across all CS/AI sections,
 * extracts novel concepts/terms from paper titles + abstracts,
 * deduplicates against existing terms, and outputs new terms in
 * the aidictionary format.
 * 
 * Usage:
 *   node scripts/arxiv-scraper.mjs [--sections cs.AI,cs.LG] [--max-papers 500] [--output terms-new.json] [--dry-run]
 */

import { writeFileSync, readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ──────────────────────────────────────────────────────
const AZURE_ENDPOINT = process.env.AZURE_ENDPOINT || 'https://footprints-ai.openai.azure.com';
const AZURE_API_KEY = process.env.AZURE_API_KEY || '';
const AZURE_MODEL = process.env.AZURE_MODEL || 'gpt-4o-mini';
const AZURE_API_VERSION = process.env.AZURE_API_VERSION || '2025-01-01-preview';

// ArXiv sections relevant to tech/AI dictionary
const ALL_SECTIONS = [
  // Core AI/ML
  'cs.AI', 'cs.LG', 'cs.CL', 'cs.CV', 'cs.NE', 'cs.MA', 'cs.IR',
  // Systems & Engineering  
  'cs.DC', 'cs.SE', 'cs.PL', 'cs.OS', 'cs.AR', 'cs.DB', 'cs.NI',
  // Security & Crypto
  'cs.CR', 'cs.CC',
  // Theory
  'cs.DS', 'cs.IT', 'cs.LO',
  // Human-Computer
  'cs.HC', 'cs.MM', 'cs.SD', 'cs.RO', 'cs.GR',
  // Other relevant
  'stat.ML', 'eess.SP', 'eess.AS', 'math.OC',
  // Quant finance / econ (for fintech terms)
  'q-fin.CP', 'econ.GN',
];

const CATEGORY_MAP = {
  'cs.AI': 'AI/ML', 'cs.LG': 'AI/ML', 'cs.CL': 'AI/ML', 'cs.CV': 'AI/ML',
  'cs.NE': 'AI/ML', 'cs.MA': 'AI/ML', 'cs.IR': 'Data Science',
  'cs.DC': 'Cloud', 'cs.SE': 'Programming', 'cs.PL': 'Programming',
  'cs.OS': 'DevOps', 'cs.AR': 'Technology', 'cs.DB': 'Data Science',
  'cs.NI': 'Technology', 'cs.CR': 'Cybersecurity', 'cs.CC': 'Technology',
  'cs.DS': 'Programming', 'cs.IT': 'Technology', 'cs.LO': 'Programming',
  'cs.HC': 'UX/UI', 'cs.MM': 'Technology', 'cs.SD': 'Technology',
  'cs.RO': 'Technology', 'cs.GR': 'Design',
  'stat.ML': 'AI/ML', 'eess.SP': 'Technology', 'eess.AS': 'Technology',
  'math.OC': 'AI/ML', 'q-fin.CP': 'Business', 'econ.GN': 'Business',
};

// ── Helpers ─────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomDelay(base) { return Math.max(1000, Math.round(base * (0.5 + Math.random()))); }

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    sections: ALL_SECTIONS,
    maxPapers: 200,       // per section
    output: join(__dirname, '..', 'arxiv-concepts.json'),
    dryRun: false,
    batchSize: 10,        // papers per LLM call
    delayMs: 3000,        // base delay between arxiv requests
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--sections' && args[i+1]) config.sections = args[++i].split(',');
    if (args[i] === '--max-papers') config.maxPapers = parseInt(args[++i]);
    if (args[i] === '--output') config.output = args[++i];
    if (args[i] === '--dry-run') config.dryRun = true;
    if (args[i] === '--batch-size') config.batchSize = parseInt(args[++i]);
    if (args[i] === '--delay') config.delayMs = parseInt(args[++i]);
  }
  return config;
}

// ── ArXiv API ───────────────────────────────────────────────────
async function fetchArxivPapers(section, maxResults = 200) {
  // Use the arXiv API (Atom feed) for structured results
  const url = `http://export.arxiv.org/api/query?search_query=cat:${section}&start=0&max_results=${maxResults}&sortBy=submittedDate&sortOrder=descending`;
  
  const res = await fetch(url, {
    headers: { 'User-Agent': 'aidictionary-concept-extractor/1.0 (https://aidictionary.dev; research-use)' },
    signal: AbortSignal.timeout(30000),
  });
  
  if (!res.ok) {
    console.error(`  ⚠️  HTTP ${res.status} for ${section}`);
    return [];
  }
  
  const xml = await res.text();
  return parseAtomFeed(xml, section);
}

function parseAtomFeed(xml, section) {
  const papers = [];
  const entries = xml.split('<entry>').slice(1); // skip feed header
  
  for (const entry of entries) {
    const title = extractTag(entry, 'title')?.replace(/\s+/g, ' ').trim();
    const summary = extractTag(entry, 'summary')?.replace(/\s+/g, ' ').trim();
    const id = extractTag(entry, 'id');
    const published = extractTag(entry, 'published');
    
    if (title && summary) {
      papers.push({
        title,
        abstract: summary.slice(0, 1500), // cap for token limits
        arxivId: id?.replace('http://arxiv.org/abs/', '') || '',
        published: published || '',
        section,
      });
    }
  }
  return papers;
}

function extractTag(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return match ? match[1].trim() : null;
}

// ── LLM Extraction ─────────────────────────────────────────────
async function extractConcepts(papers, existingTerms) {
  const paperList = papers.map((p, i) => 
    `[${i+1}] "${p.title}" (${p.section})\n${p.abstract.slice(0, 600)}`
  ).join('\n\n');

  const prompt = `You are a technical lexicographer building an AI/tech dictionary. Analyze these research papers and extract NOVEL technical concepts, methods, architectures, techniques, algorithms, benchmarks, datasets, and frameworks that would be valuable dictionary entries.

PAPERS:
${paperList}

EXISTING TERMS TO SKIP (already in dictionary):
${existingTerms.slice(0, 200).join(', ')}

RULES:
1. Extract 2-5 concepts per paper (only genuinely novel/notable ones)
2. Skip generic terms already well-known (e.g. "neural network", "deep learning", "transformer")
3. Include: new architectures (e.g. "Mamba", "RetNet"), techniques (e.g. "DPO", "RLHF"), benchmarks (e.g. "MMLU"), datasets, frameworks, metrics
4. Each definition should be 1-3 sentences, technically accurate, accessible to a developer
5. Categorize each: AI/ML, Programming, Cybersecurity, Cloud, Data Science, DevOps, Design, UX/UI, Technology, Business, Web

OUTPUT FORMAT (JSON array, nothing else):
[
  {
    "term": "Exact Term Name",
    "category": "AI/ML",
    "definition": "Clear, concise definition...",
    "seeAlso": ["Related Term 1", "Related Term 2"],
    "arxivId": "2401.12345"
  }
]

Only output the JSON array. No markdown, no explanation.`;

  const res = await fetch(
    `${AZURE_ENDPOINT}/openai/deployments/${AZURE_MODEL}/chat/completions?api-version=${AZURE_API_VERSION}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': AZURE_API_KEY,
      },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: 'You extract technical concepts from research papers for a tech dictionary. Output only valid JSON.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.3,
        max_tokens: 4000,
      }),
      signal: AbortSignal.timeout(60000),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    console.error(`  ⚠️  LLM error: ${res.status} ${err.slice(0, 200)}`);
    return [];
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content?.trim() || '';
  
  try {
    // Strip markdown code fences if present
    const clean = content.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '');
    return JSON.parse(clean);
  } catch (e) {
    console.error(`  ⚠️  JSON parse failed: ${e.message}`);
    console.error(`  Raw: ${content.slice(0, 200)}...`);
    return [];
  }
}

// ── Main ────────────────────────────────────────────────────────
async function main() {
  const config = parseArgs();
  console.log(`\n🔬 ArXiv Concept Extractor for aidictionary.dev`);
  console.log(`   Sections: ${config.sections.length}`);
  console.log(`   Max papers/section: ${config.maxPapers}`);
  console.log(`   Output: ${config.output}`);
  console.log(`   Dry run: ${config.dryRun}\n`);

  // Load existing terms to avoid duplicates
  const termsPath = join(__dirname, '..', 'src', 'content', 'en', 'terms.json');
  let existingTerms = [];
  if (existsSync(termsPath)) {
    const data = JSON.parse(readFileSync(termsPath, 'utf-8'));
    existingTerms = Object.values(data).flat().map(t => t.term.toLowerCase());
    console.log(`📚 Loaded ${existingTerms.length} existing terms\n`);
  }

  // Load previously extracted concepts (for resume)
  let allConcepts = [];
  const progressPath = config.output.replace('.json', '-progress.json');
  let completedSections = new Set();
  if (existsSync(progressPath)) {
    const progress = JSON.parse(readFileSync(progressPath, 'utf-8'));
    allConcepts = progress.concepts || [];
    completedSections = new Set(progress.completedSections || []);
    console.log(`📂 Resuming: ${allConcepts.length} concepts from ${completedSections.size} sections\n`);
  }

  const seenTerms = new Set([
    ...existingTerms,
    ...allConcepts.map(c => c.term.toLowerCase()),
  ]);

  // Phase 1: Fetch papers from each section
  let totalPapers = 0;
  const papersBySection = {};

  for (const section of config.sections) {
    if (completedSections.has(section)) {
      console.log(`⏭️  ${section} — already done, skipping`);
      continue;
    }

    console.log(`📡 Fetching ${section}...`);
    try {
      const papers = await fetchArxivPapers(section, config.maxPapers);
      papersBySection[section] = papers;
      totalPapers += papers.length;
      console.log(`   → ${papers.length} papers`);
    } catch (e) {
      console.error(`   ⚠️  Failed: ${e.message}`);
    }
    await sleep(randomDelay(config.delayMs));
  }

  console.log(`\n📄 Total papers to process: ${totalPapers}\n`);

  if (config.dryRun) {
    console.log('🏁 Dry run — stopping before LLM extraction');
    return;
  }

  // Phase 2: Extract concepts via LLM in batches
  for (const [section, papers] of Object.entries(papersBySection)) {
    console.log(`\n🧠 Extracting from ${section} (${papers.length} papers)...`);
    let sectionConcepts = 0;

    for (let i = 0; i < papers.length; i += config.batchSize) {
      const batch = papers.slice(i, i + config.batchSize);
      console.log(`   Batch ${Math.floor(i/config.batchSize)+1}/${Math.ceil(papers.length/config.batchSize)}`);

      try {
        const concepts = await extractConcepts(batch, [...seenTerms].slice(0, 300));
        
        for (const concept of concepts) {
          const key = concept.term.toLowerCase();
          if (seenTerms.has(key)) continue;
          seenTerms.add(key);
          
          // Normalize category
          if (!concept.category) concept.category = CATEGORY_MAP[section] || 'Technology';
          
          allConcepts.push(concept);
          sectionConcepts++;
        }
        
        console.log(`   → +${concepts.length} raw, +${sectionConcepts} unique (total: ${allConcepts.length})`);
      } catch (e) {
        console.error(`   ⚠️  Batch failed: ${e.message}`);
      }

      // Save progress after each batch
      writeFileSync(progressPath, JSON.stringify({
        concepts: allConcepts,
        completedSections: [...completedSections],
        lastUpdate: new Date().toISOString(),
      }, null, 2));

      await sleep(randomDelay(1500)); // Rate limit LLM calls
    }

    completedSections.add(section);
    console.log(`   ✅ ${section} done: ${sectionConcepts} new concepts`);

    // Save progress with completed section
    writeFileSync(progressPath, JSON.stringify({
      concepts: allConcepts,
      completedSections: [...completedSections],
      lastUpdate: new Date().toISOString(),
    }, null, 2));

    await sleep(randomDelay(config.delayMs));
  }

  // Phase 3: Format output in aidictionary terms.json format
  const byLetter = {};
  for (const concept of allConcepts) {
    const letter = concept.term[0].toUpperCase();
    if (!byLetter[letter]) byLetter[letter] = [];
    byLetter[letter].push({
      term: concept.term,
      category: concept.category,
      definition: concept.definition,
      seeAlso: concept.seeAlso || [],
      ...(concept.arxivId ? { arxivId: concept.arxivId } : {}),
    });
  }

  // Sort each letter's terms
  for (const letter of Object.keys(byLetter)) {
    byLetter[letter].sort((a, b) => a.term.localeCompare(b.term));
  }

  writeFileSync(config.output, JSON.stringify(byLetter, null, 2));

  // Stats
  const categories = {};
  for (const c of allConcepts) {
    categories[c.category] = (categories[c.category] || 0) + 1;
  }

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`🎉 DONE! Extracted ${allConcepts.length} unique concepts`);
  console.log(`📁 Output: ${config.output}`);
  console.log(`\nBy category:`);
  for (const [cat, count] of Object.entries(categories).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat}: ${count}`);
  }
  console.log(`${'═'.repeat(50)}\n`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
