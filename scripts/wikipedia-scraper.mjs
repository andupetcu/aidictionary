#!/usr/bin/env node

import { dedup, getExistingTermsFromDB, pushToAPI, sleep, writeDataFile } from './lib/shared.mjs';

const ROOT_CATEGORIES = [
  { name: 'Artificial_intelligence', mapped: 'AI/ML' },
  { name: 'Machine_learning', mapped: 'AI/ML' },
  { name: 'Natural_language_processing', mapped: 'AI/ML' },
  { name: 'Computer_vision', mapped: 'AI/ML' },
  { name: 'Deep_learning', mapped: 'AI/ML' },
  { name: 'Cryptography', mapped: 'Cybersecurity' },
  { name: 'Cloud_computing', mapped: 'Cloud' },
  { name: 'DevOps', mapped: 'DevOps' },
  { name: 'Software_engineering', mapped: 'Programming' },
];

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    dryRun: args.includes('--dry-run'),
    push: !args.includes('--no-push'),
    depth: Number(args.find((a) => a.startsWith('--depth='))?.split('=')[1] || 2),
    maxArticles: Number(args.find((a) => a.startsWith('--max-articles='))?.split('=')[1] || 1200),
  };
}

async function fetchWiki(params) {
  const url = new URL('https://en.wikipedia.org/w/api.php');
  Object.entries({ format: 'json', ...params }).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

async function fetchCategoryMembers(category, limit = 500) {
  const members = [];
  let cmcontinue = '';

  while (true) {
    const data = await fetchWiki({
      action: 'query',
      list: 'categorymembers',
      cmtitle: `Category:${category}`,
      cmlimit: limit,
      cmcontinue,
    });

    members.push(...(data.query?.categorymembers || []));
    cmcontinue = data.continue?.cmcontinue || '';
    if (!cmcontinue) break;
    await sleep(120);
  }

  return members;
}

async function crawlCategory(category, mappedCategory, depth, state) {
  if (depth < 0 || state.visitedCategories.has(category)) return;
  state.visitedCategories.add(category);

  let members = [];
  try {
    members = await fetchCategoryMembers(category);
  } catch (err) {
    console.error(`[wiki] Category ${category} failed: ${err.message}`);
    return;
  }

  for (const m of members) {
    if (state.articleTitles.size >= state.maxArticles) return;

    if (m.ns === 0) {
      state.articleTitles.set(m.title, mappedCategory);
      continue;
    }

    if (m.ns === 14 && depth > 0) {
      const sub = m.title.replace(/^Category:/, '').trim();
      await crawlCategory(sub, mappedCategory, depth - 1, state);
    }
  }
}

async function fetchExtracts(titles) {
  if (titles.length === 0) return [];
  const data = await fetchWiki({
    action: 'query',
    prop: 'extracts',
    exintro: 1,
    explaintext: 1,
    redirects: 1,
    titles: titles.join('|'),
  });

  const pages = data.query?.pages || {};
  return Object.values(pages)
    .map((p) => ({ title: p.title, extract: p.extract || '' }))
    .filter((p) => p.title && p.extract);
}

function sentenceDefinition(text) {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  const parts = cleaned.split(/(?<=[.!?])\s+/).slice(0, 2);
  return parts.join(' ').slice(0, 500);
}

function toTerm(title) {
  return title.replace(/\s*\([^)]*\)\s*$/g, '').trim();
}

async function main() {
  const cfg = parseArgs();
  const existingTerms = await getExistingTermsFromDB().catch(() => []);

  const state = {
    visitedCategories: new Set(),
    articleTitles: new Map(),
    maxArticles: cfg.maxArticles,
  };

  for (const root of ROOT_CATEGORIES) {
    await crawlCategory(root.name, root.mapped, cfg.depth, state);
    console.log(`[wiki] Crawled Category:${root.name}; total articles=${state.articleTitles.size}`);
    if (state.articleTitles.size >= cfg.maxArticles) break;
  }

  const titles = [...state.articleTitles.keys()];
  const chunks = [];
  for (let i = 0; i < titles.length; i += 20) chunks.push(titles.slice(i, i + 20));

  const terms = [];
  for (let i = 0; i < chunks.length; i++) {
    try {
      const extracts = await fetchExtracts(chunks[i]);
      for (const item of extracts) {
        const term = toTerm(item.title);
        const definition = sentenceDefinition(item.extract);
        if (!term || !definition) continue;
        terms.push({
          term,
          category: state.articleTitles.get(item.title) || 'Technology',
          definition,
          seeAlso: [],
          examples: [],
          source: 'wikipedia',
          source_url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, '_'))}`,
        });
      }
      if ((i + 1) % 10 === 0) console.log(`[wiki] Processed extract batch ${i + 1}/${chunks.length}`);
    } catch (err) {
      console.error(`[wiki] Extract batch ${i + 1} failed: ${err.message}`);
    }
    await sleep(100);
  }

  const unique = dedup(terms, existingTerms);
  writeDataFile('wikipedia-backfill.json', unique);
  console.log(`[wiki] Unique terms: ${unique.length}`);

  if (cfg.push) {
    try {
      const result = await pushToAPI(unique, { dryRun: cfg.dryRun, label: 'wikipedia' });
      console.log(`[wiki] Import result: ${JSON.stringify(result)}`);
    } catch (err) {
      console.error(`[wiki] Import failed: ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error('[wiki] Fatal:', err);
  process.exit(1);
});
