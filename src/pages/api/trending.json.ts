export const prerender = false;

import type { APIRoute } from 'astro';
import { getTrendingSummary, getTrendingTerms } from '../../lib/db';

export const GET: APIRoute = async () => {
  try {
    const [terms, summary] = await Promise.all([getTrendingTerms(20), getTrendingSummary()]);

    return new Response(
      JSON.stringify({
        terms,
        totalNewThisWeek: summary.total,
        topSources: summary.bySource,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: 'Failed to load trending terms', message: (err as Error).message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
