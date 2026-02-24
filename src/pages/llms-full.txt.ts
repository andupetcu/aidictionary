import terms from '../content/en/terms.json';

export async function GET() {
  const letters = Object.keys(terms).sort();
  const totalTerms = Object.values(terms).reduce((sum, arr) => sum + arr.length, 0);

  let text = `AI Dictionary — The ABCs of Everything
========================================

A comprehensive dictionary of ${totalTerms}+ terms covering technology, AI/ML, design, business, programming, web development, data science, cybersecurity, cloud computing, DevOps, and UX/UI.

Website: https://aidictionary.dev
JSON API: https://aidictionary.dev/api/terms.json

`;

  for (const letter of letters) {
    text += `${'='.repeat(60)}\n`;
    text += `${letter}\n`;
    text += `${'='.repeat(60)}\n\n`;

    for (const t of terms[letter]) {
      text += `${t.term} [${t.category}]\n`;
      text += `${'-'.repeat(t.term.length + t.category.length + 3)}\n`;
      text += `${t.definition}\n`;
      if (t.seeAlso && t.seeAlso.length > 0) {
        text += `See also: ${t.seeAlso.join(', ')}\n`;
      }
      text += `\n`;
    }
  }

  return new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
