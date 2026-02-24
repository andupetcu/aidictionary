export const prerender = false;

import type { APIRoute } from 'astro';
import { insertTerm } from '../../lib/db';

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const term = typeof body.term === 'string' ? body.term.trim() : '';
    const category = typeof body.category === 'string' ? body.category.trim() : '';
    const definition = typeof body.definition === 'string' ? body.definition.trim() : '';

    if (!term || !category || !definition) {
      return new Response(JSON.stringify({ error: 'term, category, and definition are required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const saved = await insertTerm({
      term,
      category,
      definition,
      seeAlso: Array.isArray(body.seeAlso) ? body.seeAlso : [],
      source: 'user',
      approved: false,
    });

    return new Response(JSON.stringify({ success: true, term: saved.term }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('Suggest error:', err);
    return new Response(JSON.stringify({ error: 'Failed to save suggestion' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
