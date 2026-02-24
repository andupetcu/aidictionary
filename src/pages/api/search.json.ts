export const prerender = false;

import type { APIRoute } from 'astro';
import { searchTerms } from '../../lib/db';

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const q = typeof body.q === 'string' ? body.q.trim() : '';

    if (!q || q.length < 2) {
      return new Response(JSON.stringify({ results: [], error: 'Query too short' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const results = await searchTerms(q);

    return new Response(JSON.stringify({ results }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('Search error:', err);
    return new Response(JSON.stringify({ results: [], error: 'Search failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
