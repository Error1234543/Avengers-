
const API_KEYS = [
  process.env.GROQ_API_KEY_1,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3,
].filter(Boolean);

async function callGroqWithRotation(body) {
  for (let i = 0; i < API_KEYS.length; i++) {
    const apiKey = API_KEYS[i];
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': Bearer ${apiKey}
        },
        body: JSON.stringify(body)
      });

      if (response.status === 429) {
        console.log(Key ${i + 1} rate limited, trying key ${i + 2}...);
        continue;
      }

      return response;
    } catch (err) {
      console.error(Key ${i + 1} fetch error:, err.message);
      continue;
    }
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { topic, numQ, difficulty, language, exam, subject } = req.body;

  if (!topic || !numQ) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  if (API_KEYS.length === 0) {
    return res.status(500).json({ error: 'No API keys configured' });
  }

  const langInstruction =
    language === 'Gujarati'
      ? 'IMPORTANT: Write ALL text strictly in Gujarati script (ગુજરાતી લિપિ). Every single word must be in Gujarati. No English words anywhere at all.'
      : language === 'Hindi'
      ? 'IMPORTANT: Write ALL text strictly in Hindi (हिंदी). Every single word must be in Hindi. No English words anywhere at all.'
      : 'Write everything in English.';

  // Gujarati/Hindi script uses 2-3x more tokens than English
  // Smaller batches = complete JSON, no parse failures
  const BATCH_SIZE = (language === 'Gujarati' || language === 'Hindi') ? 3 : 5;
  const MAX_TOKENS = (language === 'Gujarati' || language === 'Hindi') ? 4000 : 2000;
  const total = parseInt(numQ);
  const totalBatches = Math.ceil(total / BATCH_SIZE);
  let allQuestions = [];

  try {
    for (let batch = 0; batch < totalBatches; batch++) {
      const batchCount = Math.min(BATCH_SIZE, total - allQuestions.length);

      const prompt = Generate exactly ${batchCount} unique MCQ questions about "${topic}".
${langInstruction}
Difficulty level: ${difficulty || 'medium'}.
Exam type: ${exam || 'General'}, Subject: ${subject || 'General'}.

STRICT RULES:
- Return ONLY a valid JSON array. Nothing else.
- No markdown, no backticks, no explanation outside JSON.
- Each question must have exactly 4 options.
- "correct" field = index of correct option (0, 1, 2, or 3).

JSON Format:
[{"question":"...","options":["...","...","...","..."],"correct":0,"explanation":"..."}];

      const response = await callGroqWithRotation({
        model: 'llama-3.1-8b-instant',
        messages: [
          {
            role: 'system',
            content: You are an expert MCQ generator for competitive exams. ${langInstruction} Always respond with ONLY a valid JSON array. No extra text.
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.3,
        max_tokens: MAX_TOKENS
      });

      if (!response || !response.ok) {
        const errText = response ? await response.text() : 'All keys failed';
        console.error(Batch ${batch + 1}: API error — ${errText});
        continue;
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content?.trim();

      if (!content) {
        console.error(Batch ${batch + 1}: Empty response);
        continue;
      }

      const arrayStart = content.indexOf('[');
      const arrayEnd = content.lastIndexOf(']');

      if (arrayStart === -1 || arrayEnd === -1) {
        console.error(Batch ${batch + 1}: No JSON array found);
        continue;
      }

      let jsonStr = content.substring(arrayStart, arrayEnd + 1);
      jsonStr = jsonStr
        .replace(/,\s*]/g, ']')
        .replace(/,\s*}/g, '}');

let questions;
      try {
        questions = JSON.parse(jsonStr);
      } catch (e) {
        console.error(Batch ${batch + 1} parse error:, e.message);
        continue;
      }

      if (!Array.isArray(questions)) continue;

      const valid = questions
        .filter(q => q.question && q.question.length > 3)
        .map((q, idx) => ({
          id: allQuestions.length + idx + 1,
          question: q.question,
          options: Array.isArray(q.options) && q.options.length >= 4
            ? q.options.slice(0, 4)
            : ['Option A', 'Option B', 'Option C', 'Option D'],
          correct:
            typeof q.correct === 'number' && q.correct >= 0 && q.correct <= 3
              ? q.correct : 0,
          explanation: q.explanation || '',
          difficulty: difficulty || 'medium'
        }));

      allQuestions = [...allQuestions, ...valid];
      console.log(Batch ${batch + 1}/${totalBatches}: ${valid.length} added. Total: ${allQuestions.length});

      if (batch < totalBatches - 1) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    if (allQuestions.length === 0) {
      return res.status(500).json({ error: 'No questions could be generated. Try again later.' });
    }

    return res.status(200).json({
      title: ${exam || topic} — ${subject || topic},
      generated: allQuestions.length,
      requested: total,
      questions: allQuestions.slice(0, total)
    });

  } catch (error) {
    console.error('Handler error:', error.message);
    return res.status(500).json({ error: 'Generation failed. Please try again.' });
  }
}