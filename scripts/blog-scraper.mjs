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

const FEEDS = [
  // Anthropic has no public RSS feed
  { name: 'OpenAI', url: 'https://openai.com/blog/rss.xml' },
  { name: 'DeepMind', url: 'https://deepmind.google/blog/rss.xml' },
  // Meta AI has no public RSS feed (requires Facebook auth)
  { name: 'Google AI Blog', url: 'https://blog.research.google/feeds/posts/default?alt=rss' },
  { name: 'Hugging Face Blog', url: 'https://huggingface.co/blog/feed.xml' },
];

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    dryRun: args.includes('--dry-run'),
    push: !args.includes('--no-push'),
    days: Number(args.find((a) => a.startsWith('--days='))?.split('=')[1] || 7),
  };
}

function xmlValue(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return match ? match[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
}

function stripHtml(text = '') {
  return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseDate(raw) {
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseRSS(xml, source) {
  const items = xml.includes('<entry') ? xml.split('<entry').slice(1) : xml.split('<item').slice(1);
  return items.map((entry) => {
    const title = stripHtml(xmlValue(entry, 'title'));
    const summary = stripHtml(xmlValue(entry, 'summary') || xmlValue(entry, 'description') || xmlValue(entry, 'content'));
    const link = xmlValue(entry, 'link') || (entry.match(/<link[^>]*href="([^"]+)"/i)?.[1] || '');
    const publishedRaw = xmlValue(entry, 'published') || xmlValue(entry, 'pubDate') || xmlValue(entry, 'updated');
    const published = parseDate(publishedRaw);
    return {
      source,
      title,
      summary: summary.slice(0, 1500),
      source_url: link,
      published,
    };
  }).filter((p) => p.title && p.summary);
}

async function fetchFeed(feed) {
  const res = await fetch(feed.url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  return parseRSS(xml, feed.name);
}

function buildPrompt(posts, existingTerms) {
  const block = posts.map((p, i) =>
    `[${i + 1}] Source: ${p.source}\nTitle: ${p.title}\nSummary: ${p.summary.slice(0, 700)}\nURL: ${p.source_url}`
  ).join('\n\n');

  return `Extract dictionary-worthy technical terms from AI lab blog posts.

POSTS:
${block}

EXISTING TERMS:
${existingTerms.slice(0, 300).join(', ')}

RULES:
1. Focus on concepts, techniques, architectures, training methods, benchmarks, and tooling.
2. Skip pure announcements, company news, and marketing phrases.
3. Provide concise definition, category, and 1-2 usage examples.

Return JSON array only:
[
  {
    "term": "Constitutional AI",
    "category": "AI/ML",
    "definition": "...",
    "seeAlso": ["RLHF"],
    "examples": ["...", "..."],
    "source_url": "https://..."
  }
]`;
}

async function main() {
  const cfg = parseArgs();
  const existingTerms = await getExistingTermsFromDB().catch(() => []);

  const allPosts = [];
  for (const feed of FEEDS) {
    try {
      const posts = await fetchFeed(feed);
      allPosts.push(...posts);
      console.log(`[blogs] ${feed.name}: ${posts.length} posts`);
    } catch (err) {
      console.error(`[blogs] ${feed.name} failed: ${err.message}`);
    }
    await sleep(400);
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - cfg.days);
  const recent = allPosts.filter((p) => p.published && p.published >= cutoff);

  const batches = chunk(recent, 16);
  const extracted = [];

  for (let i = 0; i < batches.length; i++) {
    try {
      const content = await callGPT(buildPrompt(batches[i], [...existingTerms, ...extracted.map((t) => t.term.toLowerCase())]), {
        systemPrompt: 'Return valid JSON array only.',
        maxTokens: 3500,
      });
      const parsed = parseJSONArray(content).map((t) => ({ ...t, source: 'blogs' }));
      extracted.push(...parsed);
      console.log(`[blogs] Batch ${i + 1}/${batches.length}: +${parsed.length}`);
    } catch (err) {
      console.error(`[blogs] Batch ${i + 1} failed: ${err.message}`);
    }
    await sleep(800);
  }

  const unique = dedup(extracted, existingTerms);
  writeDataFile('blog-terms.json', unique);
  console.log(`[blogs] Unique terms: ${unique.length}`);

  if (cfg.push) {
    try {
      const result = await pushToAPI(unique, { dryRun: cfg.dryRun, label: 'blogs' });
      console.log(`[blogs] Import result: ${JSON.stringify(result)}`);
    } catch (err) {
      console.error(`[blogs] Import failed: ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error('[blogs] Fatal:', err);
  process.exit(1);
});
