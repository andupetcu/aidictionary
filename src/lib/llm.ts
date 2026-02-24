const VALID_CATEGORIES = [
  'AI/ML', 'Business', 'Cloud', 'Cybersecurity', 'Data Science',
  'Design', 'DevOps', 'Programming', 'Technology', 'UX/UI', 'Web',
] as const;

interface GeneratedTerm {
  term: string;
  category: string;
  definition: string;
  seeAlso: string[];
}

export async function generateDefinition(termName: string): Promise<GeneratedTerm> {
  const endpoint = import.meta.env.AZURE_OPENAI_ENDPOINT || process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = import.meta.env.AZURE_OPENAI_KEY || process.env.AZURE_OPENAI_KEY;

  if (!endpoint || !apiKey) {
    throw new Error('Azure OpenAI credentials not configured');
  }

  const prompt = `You are a technical dictionary editor. Generate a dictionary entry for the term "${termName}".

Return ONLY valid JSON (no markdown, no code fences) in this exact format:
{
  "term": "${termName}",
  "category": "one of: AI/ML, Business, Cloud, Cybersecurity, Data Science, Design, DevOps, Programming, Technology, UX/UI, Web",
  "definition": "A clear, concise 2-3 sentence definition.",
  "seeAlso": ["Related Term 1", "Related Term 2"]
}

The category MUST be exactly one of: ${VALID_CATEGORIES.join(', ')}.
The definition should be informative and accessible to a technical audience.
seeAlso should contain 2-4 related terms that would appear in a tech dictionary.`;

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

  if (!text) {
    throw new Error('No text in Azure OpenAI response');
  }

  const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  const parsed: GeneratedTerm = JSON.parse(cleaned);

  if (!VALID_CATEGORIES.includes(parsed.category as typeof VALID_CATEGORIES[number])) {
    parsed.category = 'Technology';
  }

  parsed.term = parsed.term || termName;
  parsed.seeAlso = Array.isArray(parsed.seeAlso) ? parsed.seeAlso : [];

  return parsed;
}
