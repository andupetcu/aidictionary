# PRD: Phases 3 & 4 — Multi-Source Scrapers + Content Quality

## Overview
Expand aidictionary.dev beyond ArXiv with 4 new sources (HuggingFace, GitHub Trending, Tech Blogs, Wikipedia), and add content quality features (cross-linking, usage examples, trending terms).

## Phase 3: New Scrapers

### 3A. HuggingFace Scraper (`scripts/hf-scraper.mjs`)
Scrape HuggingFace for new AI model/technique names.

**Sources (all free, no auth needed):**
- Daily Papers API: `https://huggingface.co/api/daily_papers` → titles + abstracts
- Trending Models: `https://huggingface.co/api/models?sort=trending&limit=100` → model names, tags, descriptions
- Trending Datasets: `https://huggingface.co/api/datasets?sort=trending&limit=50`

**Extraction logic:**
1. Fetch daily papers → extract paper titles + abstracts
2. Fetch trending models → extract model family names (e.g., "Llama", "Mistral", "SDXL"), technique tags
3. Use Azure OpenAI (gpt-4o-mini) to extract terms from batched titles/descriptions, same prompt style as arxiv-scraper
4. Dedup against existing terms in DB via `/api/import.json`

**Output:** `data/hf-daily.json` → push to import API

### 3B. GitHub Trending Scraper (`scripts/github-trending.mjs`)
Scrape GitHub trending repos for new tool/framework names.

**Source:** 
- `https://api.github.com/search/repositories?q=stars:>100+created:>YYYY-MM-DD&sort=stars&order=desc` (past 7 days)
- Also: `https://github.com/trending?since=daily` (parse HTML if needed, but prefer API)
- Filter to relevant topics: `machine-learning`, `artificial-intelligence`, `deep-learning`, `llm`, `nlp`, `computer-vision`, `data-science`, `devops`, `cloud`, `cybersecurity`

**Extraction logic:**
1. Fetch trending/new repos with AI/tech topics
2. Extract: repo name (if it's a real term/tool), description
3. Use GPT to determine if repo name is a dictionary-worthy term (skip generic names like "awesome-list")
4. Generate definition from repo description + README excerpt

**Output:** `data/github-trending.json` → push to import API

### 3C. Tech Blog Scraper (`scripts/blog-scraper.mjs`)
Scrape official AI lab blogs for new terminology.

**Blogs to scrape (RSS/Atom feeds):**
- Anthropic: `https://www.anthropic.com/feed.xml` or `/research/feed.xml`
- OpenAI: `https://openai.com/blog/rss.xml`
- DeepMind: `https://deepmind.google/blog/rss.xml`
- Meta AI: `https://ai.meta.com/blog/rss/`
- Google AI Blog: `https://blog.research.google/feeds/posts/default?alt=rss`
- Hugging Face blog: `https://huggingface.co/blog/feed.xml`

**Extraction logic:**
1. Fetch RSS feeds, get posts from last 7 days
2. Extract title + summary/content
3. Batch through GPT to extract new terms, concepts, model names
4. Quality filter (skip marketing terms, product announcements without technical substance)

**Output:** `data/blog-terms.json` → push to import API

### 3D. Wikipedia CS/AI Backfill (`scripts/wikipedia-scraper.mjs`)
Backfill established CS/AI terms from Wikipedia.

**Source:** Wikipedia API
- Category members: `https://en.wikipedia.org/w/api.php?action=query&list=categorymembers&cmtitle=Category:Artificial_intelligence&cmlimit=500&format=json`
- Key categories: `Artificial_intelligence`, `Machine_learning`, `Natural_language_processing`, `Computer_vision`, `Deep_learning`, `Cryptography`, `Cloud_computing`, `DevOps`, `Software_engineering`
- For each article: `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro&explaintext&titles=...&format=json`

**Extraction logic:**
1. Crawl category trees (2 levels deep)
2. For each article: get intro paragraph
3. Use the first 1-2 sentences as definition (Wikipedia intros are already definition-like)
4. Map Wikipedia category → aidictionary category
5. Dedup against existing DB terms
6. Set source = 'wikipedia'

**Output:** `data/wikipedia-backfill.json` → push to import API
**Note:** This is a one-time backfill, not daily. Run once, then only refresh monthly.

### Unified Daily Runner (`scripts/scrape-all.mjs`)
Orchestrates all scrapers:
```
node scripts/scrape-all.mjs [--sources arxiv,hf,github,blogs] [--dry-run]
```
Default: run all sources. Each source saves to `data/` and pushes to import API.

## Phase 4: Content Quality

### 4A. Cross-linking / Related Terms
**DB changes:** Add `related_terms TEXT[]` column to `terms` table (separate from `see_also` which is manually curated).

**Script:** `scripts/build-relations.mjs`
1. For each term, find other terms mentioned in its definition (exact match, case-insensitive)
2. Also check: terms whose `see_also` references this term
3. Store bidirectional links in `related_terms`
4. Run after each import batch

**Frontend:** On definition page (`src/pages/definition/[slug].astro`):
- Keep existing "See Also" section (manual/curated)
- Add new "Related Terms" section below it (auto-generated, styled slightly differently)

### 4B. Usage Examples from Papers
**DB changes:** Add `examples TEXT[]` column to `terms` table.

**During ArXiv/HF scraping:** When GPT extracts a term, also extract 1-2 usage sentences from the paper abstract where the term appears in context.

**Update GPT prompt in arxiv-scraper.mjs** to also return:
```json
{
  "term": "...",
  "definition": "...",
  "examples": ["In our experiments, <term> achieved 95% accuracy on...", "We apply <term> to the task of..."]
}
```

**Frontend:** On definition page, show "Usage in Research" section with example sentences (italicized, with source attribution).

### 4C. Trending Terms Section on Homepage
**New API endpoint:** `src/pages/api/trending.json.ts`
- Returns terms sorted by `created_at DESC` where `created_at > NOW() - INTERVAL '7 days'`
- Limit 20
- Also returns: total new terms this week, top source breakdown

**Homepage update** (`src/pages/index.astro`):
- Add "🔥 Trending This Week" section between hero and A-Z grid
- Show 8-12 newest terms as clickable cards/pills
- Each shows: term name, category badge, "New" indicator
- Subtitle: "X new terms added this week from ArXiv, HuggingFace, and more"

### 4D. Improve Import API
Update `src/pages/api/import.json.ts`:
- Accept `examples` field in term submissions
- Accept `related_terms` field
- Accept `source_url` field (link to paper/repo/blog post)
- Run cross-linking after batch import

## Technical Details

### Environment Variables (all scrapers)
```
AZURE_ENDPOINT=https://footprints-ai.openai.azure.com
AZURE_API_KEY=<key>
AZURE_MODEL=gpt-4o-mini
IMPORT_SECRET=<secret for /api/import.json>
API_BASE=https://aidictionary.dev
DATABASE_URL=postgresql://localhost:5432/aidictionary
```

### DB Migrations (in merge script or seed)
```sql
ALTER TABLE terms ADD COLUMN IF NOT EXISTS related_terms TEXT[] DEFAULT '{}';
ALTER TABLE terms ADD COLUMN IF NOT EXISTS examples TEXT[] DEFAULT '{}';
ALTER TABLE terms ADD COLUMN IF NOT EXISTS source_url TEXT;
```

### Shared Utilities
Reuse from `scripts/arxiv-scraper.mjs`:
- GPT extraction prompt pattern
- Rate limiting / sleep
- Dedup logic
- Output format

Extract shared code into `scripts/lib/shared.mjs`:
- `callGPT(prompt)` — Azure OpenAI wrapper
- `dedup(newTerms, existingTerms)` — dedup helper
- `pushToAPI(terms)` — import API client
- `sleep(ms)`

### Cron Schedule (OpenClaw)
Update existing `aidictionary-arxiv-daily` cron to run `scrape-all.mjs` instead:
- 6:00 AM daily: ArXiv + HuggingFace + GitHub + Blogs
- 1st of month: Wikipedia refresh

## File Structure
```
scripts/
  lib/
    shared.mjs          # Shared utilities (GPT, dedup, API push)
  arxiv-scraper.mjs     # Existing (refactor to use shared.mjs)
  hf-scraper.mjs        # NEW: HuggingFace papers + models
  github-trending.mjs   # NEW: GitHub trending repos
  blog-scraper.mjs      # NEW: Tech blog RSS feeds
  wikipedia-scraper.mjs # NEW: Wikipedia backfill
  build-relations.mjs   # NEW: Cross-linking builder
  scrape-all.mjs        # NEW: Unified daily runner
  merge-arxiv.mjs       # Existing
  arxiv-daily.mjs       # Existing (update to call scrape-all)
  seed.mjs              # Existing
```

## Acceptance Criteria
- [ ] HuggingFace scraper extracts terms from daily papers + trending models
- [ ] GitHub scraper finds new AI/tech tools from trending repos
- [ ] Blog scraper processes 6+ AI lab RSS feeds
- [ ] Wikipedia backfill adds 500+ established CS/AI terms
- [ ] All scrapers push to import API with quality filtering
- [ ] Shared utilities extracted, DRY codebase
- [ ] Cross-linking: definition pages show "Related Terms"
- [ ] Usage examples shown on definition pages (where available)
- [ ] Trending section on homepage with this week's new terms
- [ ] Import API accepts examples, related_terms, source_url
- [ ] DB migrations applied
- [ ] `scrape-all.mjs` runs all sources in sequence
- [ ] Existing cron updated to use scrape-all
- [ ] All scripts handle errors gracefully (one source failing doesn't kill others)
