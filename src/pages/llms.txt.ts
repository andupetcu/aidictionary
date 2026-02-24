import terms from '../content/en/terms.json';

export async function GET() {
  const letters = Object.keys(terms).sort();
  const totalTerms = Object.values(terms).reduce((sum, arr) => sum + arr.length, 0);

  let text = `# AI Dictionary — The ABCs of Everything

> A comprehensive dictionary of ${totalTerms}+ terms covering technology, AI/ML, design, business, programming, web development, data science, cybersecurity, cloud computing, DevOps, and UX/UI.

## Pages

- [Home](https://aidictionary.dev/): Main page with A-Z navigation and term previews
- [Search](https://aidictionary.dev/search): Client-side search across all terms
- [About](https://aidictionary.dev/about): About this dictionary
- [API](https://aidictionary.dev/api/terms.json): Full dictionary as JSON

## Letter Pages

`;

  for (const letter of letters) {
    const termNames = terms[letter].map(t => t.term).join(', ');
    text += `- [${letter}](https://aidictionary.dev/${letter.toLowerCase()}): ${terms[letter].length} terms — ${termNames}\n`;
  }

  text += `
## Machine-Readable Content

- [llms-full.txt](https://aidictionary.dev/llms-full.txt): Complete dictionary content in plain text
- [terms.json](https://aidictionary.dev/api/terms.json): Full dictionary as JSON API
`;

  return new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
