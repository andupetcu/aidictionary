export const prerender = false;

import type { APIRoute } from 'astro';
import { generateDefinition } from '../../lib/llm';
import { insertTerm, searchTerms } from '../../lib/db';

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const termName = typeof body.term === 'string' ? body.term.trim() : '';

    if (!termName || termName.length < 2 || termName.length > 100) {
      return new Response(JSON.stringify({ error: 'Invalid term' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Check if term already exists in DB
    const existing = await searchTerms(termName);
    const exact = existing.find(t => t.term.toLowerCase() === termName.toLowerCase());
    if (exact) {
      return new Response(JSON.stringify({ term: exact, source: 'database' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Generate with LLM
    const generated = await generateDefinition(termName);

    // Save to database
    const saved = await insertTerm({
      term: generated.term,
      category: generated.category,
      definition: generated.definition,
      seeAlso: generated.seeAlso,
      source: 'llm',
      approved: true,
    });

    const letter = /^[a-z]/i.test(saved.term) ? saved.term[0].toUpperCase() : '#';

    return new Response(JSON.stringify({
      term: {
        term: saved.term,
        slug: saved.slug,
        letter,
        category: saved.category,
        definition: saved.definition,
        seeAlso: saved.see_also || [],
        source: saved.source,
      },
      source: 'llm',
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('Generate error:', err);
    return new Response(JSON.stringify({ error: 'Failed to generate definition' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
