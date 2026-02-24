import terms from '../../content/en/terms.json';

export async function GET() {
  return new Response(JSON.stringify(terms, null, 2), {
    headers: { 'Content-Type': 'application/json' },
  });
}
