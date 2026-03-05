#!/usr/bin/env node

import {
  callGPT,
  chunk,
  dedup,
  getExistingTermsFromDB,
  parseJSONArray,
  pushToAPI,
  sleep,
  writeDataFile,
} from './lib/shared.mjs';

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    dryRun: args.includes('--dry-run'),
    push: !args.includes('--no-push'),
    batchSize: 20,
  };
}

async function fetchJSON(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return await res.json();
}

async function fetchSources() {
  const [dailyRaw, modelsRaw, datasetsRaw] = await Promise.allSettled([
    fetchJSON('https://huggingface.co/api/daily_papers'),
    fetchJSON('https://huggingface.co/api/models?sort=trending&limit=100'),
    fetchJSON('https://huggingface.co/api/datasets?sort=trending&limit=50'),
  ]);

  const daily = dailyRaw.status === 'fulfilled' ? dailyRaw.value : [];
  const models = modelsRaw.status === 'fulfilled' ? modelsRaw.value : [];
  const datasets = datasetsRaw.status === 'fulfilled' ? datasetsRaw.value : [];

  if (dailyRaw.status === 'rejected') console.error(`[hf] Daily papers failed: ${dailyRaw.reason?.message || dailyRaw.reason}`);
  if (modelsRaw.status === 'rejected') console.error(`[hf] Models failed: ${modelsRaw.reason?.message || modelsRaw.reason}`);
  if (datasetsRaw.status === 'rejected') console.error(`[hf] Datasets failed: ${datasetsRaw.reason?.message || datasetsRaw.reason}`);

  return { daily, models, datasets };
}

function normalizeInput({ daily, models, datasets }) {
  const docs = [];

  for (const p of daily || []) {
    const title = p.paper?.title || p.title;
    const abstract = p.paper?.summary || p.summary || '';
    if (!title || !abstract) continue;
    docs.push({
      type: 'paper',
      title,
      text: abstract,
      source_url: p.paper?.url || p.url || (p.paper?.id ? `https://huggingface.co/papers/${p.paper.id}` : 'https://huggingface.co/papers'),
    });
  }

  for (const m of models || []) {
    docs.push({
      type: 'model',
      title: m.modelId || m.id || m._id || '',
      text: `${m.pipeline_tag || ''} ${Array.isArray(m.tags) ? m.tags.join(', ') : ''} ${m.cardData?.summary || ''}`.trim(),
      source_url: m.modelId ? `https://huggingface.co/${m.modelId}` : 'https://huggingface.co/models',
    });
  }

  for (const d of datasets || []) {
    docs.push({
      type: 'dataset',
      title: d.id || d._id || '',
      text: `${Array.isArray(d.tags) ? d.tags.join(', ') : ''} ${d.description || ''}`.trim(),
      source_url: d.id ? `https://huggingface.co/datasets/${d.id}` : 'https://huggingface.co/datasets',
    });
  }

  return docs.filter((d) => d.title && d.text);
}

function buildPrompt(batch, existingTerms) {
  const items = batch.map((b, i) => `[${i + 1}] ${b.type.toUpperCase()}\nTitle: ${b.title}\nContent: ${b.text.slice(0, 700)}\nURL: ${b.source_url}`).join('\n\n');

  return `Extract dictionary-worthy AI/ML and software terms from Hugging Face content.

INPUT:
${items}

SKIP TERMS:
${existingTerms.slice(0, 300).join(', ')}

RULES:
1. Focus on model families, algorithms, datasets, benchmarks, and techniques.
2. Skip generic and marketing terms.
3. For each term: concise definition, category, 1-2 contextual examples.
4. Use categories: AI/ML, Programming, Cybersecurity, Cloud, Data Science, DevOps, Design, UX/UI, Technology, Business, Web.

Return JSON array only:
[
  {
    "term": "Llama 3",
    "category": "AI/ML",
    "definition": "...",
    "seeAlso": ["Transformer"],
    "examples": ["...", "..."],
    "source_url": "https://huggingface.co/..."
  }
]`;
}

async function extractTerms(docs, existingTerms, batchSize) {
  const all = [];
  const batches = chunk(docs, batchSize);

  for (let i = 0; i < batches.length; i++) {
    try {
      const content = await callGPT(buildPrompt(batches[i], [...existingTerms, ...all.map((t) => t.term.toLowerCase())]), {
        systemPrompt: 'Return valid JSON array only.',
        maxTokens: 3500,
      });
      const parsed = parseJSONArray(content).map((t) => ({ ...t, source: 'huggingface' }));
      all.push(...parsed);
      console.log(`[hf] Batch ${i + 1}/${batches.length}: +${parsed.length}`);
    } catch (err) {
      console.error(`[hf] Batch ${i + 1} failed: ${err.message}`);
    }
    await sleep(800);
  }

  return all;
}

async function main() {
  const cfg = parseArgs();
  const existingTerms = await getExistingTermsFromDB().catch(() => []);

  const sources = await fetchSources();
  const docs = normalizeInput(sources);
  console.log(`[hf] Input documents: ${docs.length}`);

  const extracted = await extractTerms(docs, existingTerms, cfg.batchSize);
  const unique = dedup(extracted, existingTerms);

  writeDataFile('hf-daily.json', unique);
  console.log(`[hf] Unique terms: ${unique.length}`);

  if (cfg.push) {
    try {
      const result = await pushToAPI(unique, { dryRun: cfg.dryRun, label: 'hf' });
      console.log(`[hf] Import result: ${JSON.stringify(result)}`);
    } catch (err) {
      console.error(`[hf] Import failed: ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error('[hf] Fatal:', err);
  process.exit(1);
});
