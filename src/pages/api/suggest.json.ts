export const prerender = false;

import type { APIRoute } from 'astro';
import { insertTerm, query } from '../../lib/db';

const VALID_CATEGORIES = [
  'AI/ML', 'Business', 'Cloud', 'Cybersecurity', 'Data Science',
  'Design', 'DevOps', 'Programming', 'Technology', 'UX/UI', 'Web',
];

interface ReviewResult {
  decision: 'approve' | 'edit' | 'reject';
  review: string;
  edited?: {
    term?: string;
    category?: string;
    definition?: string;
    seeAlso?: string[];
  };
}

async function reviewWithLLM(submission: {
  term: string;
  category: string;
  definition: string;
  seeAlso: string[];
}): Promise<ReviewResult> {
  const endpoint = import.meta.env.AZURE_OPENAI_ENDPOINT || process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = import.meta.env.AZURE_OPENAI_KEY || process.env.AZURE_OPENAI_KEY;

  if (!endpoint || !apiKey) {
    throw new Error('Azure OpenAI credentials not configured');
  }

  const prompt = `You are a senior editor for a technology dictionary (aidictionary.dev). Review this user-submitted term.

SUBMISSION:
- Term: "${submission.term}"
- Category: "${submission.category}"
- Definition: "${submission.definition}"
- See Also: ${JSON.stringify(submission.seeAlso)}

VALID CATEGORIES: ${VALID_CATEGORIES.join(', ')}

REVIEW CRITERIA:
1. Is this a real, legitimate technology/computing/business term? (Not gibberish, not offensive, not a person's name unless they're a well-known concept like "Turing")
2. Is the category correct?
3. Is the definition accurate, clear, and 2-3 sentences?
4. Are the seeAlso terms relevant?

DECISIONS:
- "approve": The submission is accurate and well-written. Publish as-is.
- "edit": The term is valid but the definition needs improvement. Provide an edited version.
- "reject": The term is not appropriate (not a real term, offensive, spam, too vague, duplicate concept).

Return ONLY valid JSON (no markdown, no code fences):
{
  "decision": "approve" | "edit" | "reject",
  "review": "Brief explanation of your decision (1-2 sentences, shown to user)",
  "edited": {
    "term": "corrected term name if needed",
    "category": "corrected category if needed",
    "definition": "improved definition if decision is edit",
    "seeAlso": ["corrected", "related", "terms"]
  }
}

The "edited" field is only required when decision is "edit". For "approve" or "reject", omit it or set to null.`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-5.2',
      input: prompt,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Azure OpenAI error ${res.status}: ${body}`);
  }

  const data = await res.json();
  const text = data.output?.[0]?.content?.[0]?.text;
  if (!text) throw new Error('No text in LLM response');

  const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  return JSON.parse(cleaned);
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const term = typeof body.term === 'string' ? body.term.trim() : '';
    const category = typeof body.category === 'string' ? body.category.trim() : '';
    const definition = typeof body.definition === 'string' ? body.definition.trim() : '';
    const seeAlso = Array.isArray(body.seeAlso) ? body.seeAlso.filter((s: unknown) => typeof s === 'string') : [];

    if (!term || !category || !definition) {
      return new Response(JSON.stringify({ error: 'Term, category, and definition are required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!VALID_CATEGORIES.includes(category)) {
      return new Response(JSON.stringify({ error: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}` }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Check if term already exists
    const slug = term.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const existing = await query('SELECT term FROM terms WHERE slug = $1 AND approved = true LIMIT 1', [slug]);
    if (existing.rows.length > 0) {
      return new Response(JSON.stringify({ 
        error: `"${existing.rows[0].term}" already exists in the dictionary.`,
        decision: 'rejected',
        review: 'This term is already in our dictionary.'
      }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // AI Review
    const review = await reviewWithLLM({ term, category, definition, seeAlso });

    if (review.decision === 'approve') {
      const saved = await insertTerm({
        term,
        category,
        definition,
        seeAlso,
        source: 'user',
        approved: true,
      });
      return new Response(JSON.stringify({
        decision: 'approved',
        review: review.review,
        published: {
          term: saved.term,
          slug: saved.slug,
          letter: saved.letter,
          category: saved.category,
          definition: saved.definition,
          seeAlso: saved.see_also || seeAlso,
        },
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (review.decision === 'edit' && review.edited) {
      const finalTerm = review.edited.term || term;
      const finalCategory = VALID_CATEGORIES.includes(review.edited.category || '') ? review.edited.category! : category;
      const finalDef = review.edited.definition || definition;
      const finalSeeAlso = Array.isArray(review.edited.seeAlso) ? review.edited.seeAlso : seeAlso;

      const saved = await insertTerm({
        term: finalTerm,
        category: finalCategory,
        definition: finalDef,
        seeAlso: finalSeeAlso,
        source: 'user',
        approved: true,
      });
      return new Response(JSON.stringify({
        decision: 'edited',
        review: review.review,
        published: {
          term: saved.term,
          slug: saved.slug,
          letter: saved.letter,
          category: saved.category,
          definition: saved.definition,
          seeAlso: saved.see_also || finalSeeAlso,
        },
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Rejected
    return new Response(JSON.stringify({
      decision: 'rejected',
      review: review.review,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (err) {
    console.error('Suggest error:', err);
    return new Response(JSON.stringify({ error: 'Review failed. Please try again.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
