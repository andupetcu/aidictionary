#!/usr/bin/env node

import {
  callGPT,
  dedup,
  getExistingTermsFromDB,
  parseJSONArray,
  pushToAPI,
  sleep,
  writeDataFile,
} from './lib/shared.mjs';

const TOPICS = [
  'machine-learning',
  'artificial-intelligence',
  'deep-learning',
  'llm',
  'nlp',
  'computer-vision',
  'data-science',
  'devops',
  'cloud',
  'cybersecurity',
];

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    dryRun: args.includes('--dry-run'),
    push: !args.includes('--no-push'),
    days: Number(args.find((a) => a.startsWith('--days='))?.split('=')[1] || 7),
  };
}

function daysAgoISO(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

async function fetchRepoReadme(fullName) {
  try {
    const res = await fetch(`https://api.github.com/repos/${fullName}/readme`, {
      headers: {
        Accept: 'application/vnd.github.raw+json',
        'User-Agent': 'aidictionary-scraper',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return '';
    const text = await res.text();
    return text.slice(0, 1200);
  } catch {
    return '';
  }
}

async function fetchTrendingRepos(days) {
  const createdAfter = daysAgoISO(days);
  const seen = new Set();
  const repos = [];

  for (const topic of TOPICS) {
    try {
      const q = encodeURIComponent(`stars:>100 created:>${createdAfter} topic:${topic}`);
      const url = `https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=40`;
      const res = await fetch(url, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'aidictionary-scraper',
        },
        signal: AbortSignal.timeout(25000),
      });
      if (!res.ok) {
        console.error(`[github] ${topic} request failed HTTP ${res.status}`);
        continue;
      }

      const data = await res.json();
      for (const repo of data.items || []) {
        if (seen.has(repo.full_name)) continue;
        seen.add(repo.full_name);
        repos.push(repo);
      }
      await sleep(400);
    } catch (err) {
      console.error(`[github] ${topic} failed: ${err.message}`);
    }
  }

  return repos;
}

async function buildDocs(repos) {
  const docs = [];
  for (const repo of repos) {
    const readme = await fetchRepoReadme(repo.full_name);
    docs.push({
      name: repo.name,
      full_name: repo.full_name,
      description: repo.description || '',
      topics: Array.isArray(repo.topics) ? repo.topics : [],
      stars: repo.stargazers_count || 0,
      readme,
      source_url: repo.html_url,
    });
    await sleep(150);
  }
  return docs;
}

function buildPrompt(docs, existingTerms) {
  const block = docs.map((d, i) =>
    `[${i + 1}] Repo: ${d.full_name}\nName: ${d.name}\nStars: ${d.stars}\nTopics: ${d.topics.join(', ')}\nDescription: ${d.description}\nREADME excerpt: ${d.readme.slice(0, 500)}\nURL: ${d.source_url}`
  ).join('\n\n');

  return `Select dictionary-worthy technical terms/tools from these GitHub trending repositories.

REPOSITORIES:
${block}

EXISTING TERMS:
${existingTerms.slice(0, 300).join(', ')}

RULES:
1. Include only specific tool/framework/library names with technical meaning.
2. Skip generic names, "awesome" lists, templates, and personal repos.
3. Generate a clear definition from description/README.
4. Add category and 1-2 usage examples.

Return JSON array only:
[
  {
    "term": "vLLM",
    "category": "AI/ML",
    "definition": "...",
    "seeAlso": ["LLM Inference"],
    "examples": ["...", "..."],
    "source_url": "https://github.com/..."
  }
]`;
}

async function extractTerms(docs, existingTerms) {
  if (docs.length === 0) return [];
  const content = await callGPT(buildPrompt(docs, existingTerms), {
    systemPrompt: 'Return valid JSON array only.',
    maxTokens: 4000,
    temperature: 0.1,
  });
  return parseJSONArray(content).map((t) => ({ ...t, source: 'github' }));
}

async function main() {
  const cfg = parseArgs();
  const existingTerms = await getExistingTermsFromDB().catch(() => []);

  const repos = await fetchTrendingRepos(cfg.days);
  console.log(`[github] Repositories collected: ${repos.length}`);

  const docs = await buildDocs(repos.slice(0, 80));
  const extracted = await extractTerms(docs, existingTerms).catch((err) => {
    console.error(`[github] GPT extraction failed: ${err.message}`);
    return [];
  });

  const unique = dedup(extracted, existingTerms);
  writeDataFile('github-trending.json', unique);
  console.log(`[github] Unique terms: ${unique.length}`);

  if (cfg.push) {
    try {
      const result = await pushToAPI(unique, { dryRun: cfg.dryRun, label: 'github' });
      console.log(`[github] Import result: ${JSON.stringify(result)}`);
    } catch (err) {
      console.error(`[github] Import failed: ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error('[github] Fatal:', err);
  process.exit(1);
});
