export const prerender = false;

import type { APIRoute } from 'astro';
import { query } from '../../lib/db';

export const GET: APIRoute = async () => {
  const { rows } = await query(
    'SELECT slug, updated_at FROM terms WHERE approved = true ORDER BY slug'
  );

  const urls = rows.map((r: any) => {
    const lastmod = r.updated_at
      ? new Date(r.updated_at).toISOString().split('T')[0]
      : new Date().toISOString().split('T')[0];
    return `  <url>
    <loc>https://aidictionary.dev/definition/${r.slug}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>`;
  }).join('\n');

  // Static pages
  const staticPages = [
    { loc: '/', priority: '1.0', freq: 'daily' },
    { loc: '/search', priority: '0.8', freq: 'weekly' },
    { loc: '/contribute', priority: '0.5', freq: 'monthly' },
    { loc: '/about', priority: '0.4', freq: 'monthly' },
  ];

  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ#'.split('');
  const letterPages = letters.map(l => ({
    loc: `/${l === '#' ? '%23' : l.toLowerCase()}`,
    priority: '0.6',
    freq: 'weekly',
  }));

  const categories = ['ai-ml', 'programming', 'technology', 'data-science', 'cybersecurity', 'web', 'cloud', 'devops', 'business', 'design', 'ux-ui'];
  const categoryPages = categories.map(c => ({
    loc: `/category/${c}`,
    priority: '0.6',
    freq: 'weekly',
  }));

  const allStatic = [...staticPages, ...letterPages, ...categoryPages];
  const staticUrls = allStatic.map(p => `  <url>
    <loc>https://aidictionary.dev${p.loc}</loc>
    <changefreq>${p.freq}</changefreq>
    <priority>${p.priority}</priority>
  </url>`).join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${staticUrls}
${urls}
</urlset>`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
