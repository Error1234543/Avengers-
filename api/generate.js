export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { topic, numQ, difficulty, language, exam, subject } = req.body;

  if (!topic || !numQ) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server not configured' });
  }

  // ✅ Batch size fix - 10 per request
  const BATCH_SIZE = 10;
  const totalBatches = Math.ceil(numQ / BATCH_SIZE);
  let allQuestions = [];

  try {
    for (let batch = 0; batch < totalBatches; batch++) {
      const remaining = numQ - allQuestions.length;
      const batchCount = Math.min(BATCH_SIZE, remaining);
      const startId = allQuestions.length + 1;

      const prompt = `Generate exactly ${batchCount} unique MCQ questions about "${topic}".
Difficulty: ${difficulty || 'medium'}.
Start question numbering from ${startId}.
Return ONLY a valid JSON array. No markdown, no explanation outside JSON.

[
  {
    "question": "Question text?",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correct": 0,
    "explanation": "Brief explanation"
  }
]`;

      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          max_tokens: 2500  // ✅ 10 MCQ ke liye enough
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`Batch ${batch + 1} failed:`, errText);
        // ✅ Partial results return karo, fail mat karo
        break;
      }

      const data = await response.json();
      let content = data.choices[0].message.content;

      // Clean
      content = content.trim()
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();

      const arrayStart = content.indexOf('[');
      const arrayEnd = content.lastIndexOf(']');

      if (arrayStart === -1 || arrayEnd === -1) {
        console.error(`Batch ${batch + 1}: No JSON array found`);
        continue; // ✅ Skip bad batch, don't crash
      }

      let jsonArray = content.substring(arrayStart, arrayEnd + 1);
      jsonArray = jsonArray
        .replace(/,\s*]/g, ']')
        .replace(/,\s*}/g, '}')
        .replace(/\n\s*/g, ' ');

      let questions;
      try {
        questions = JSON.parse(jsonArray);
      } catch (e) {
        console.error(`Batch ${batch + 1} parse error:`, e.message);
        continue; // ✅ Skip, don't crash
      }

      if (!Array.isArray(questions)) continue;

      const validBatch = questions
        .filter(q => q.question && q.question.length > 0)
        .map((q, idx) => ({
          id: allQuestions.length + idx + 1,
          question: q.question,
          options: Array.isArray(q.options) && q.options.length >= 4
            ? q.options.slice(0, 4)
            : ['Option A', 'Option B', 'Option C', 'Option D'],
          correct: typeof q.correct === 'number' && q.correct >= 0 && q.correct <= 3
            ? q.correct : 0,
          explanation: q.explanation || '',
          difficulty: difficulty || 'medium'
        }));

      allQuestions = [...allQuestions, ...validBatch];

      // ✅ Rate limit se bachne ke liye small delay
      if (batch < totalBatches - 1) {
        await new Promise(r => setTimeout(r, 300));
      }
    }

    if (allQuestions.length === 0) {
      return res.status(400).json({ error: 'No questions could be generated' });
    }

    return res.status(200).json({
      title: `${exam || topic} - ${subject || topic}`,
      generated: allQuestions.length,
      requested: numQ,
      questions: allQuestions.slice(0, numQ)
    });

  } catch (error) {
    console.error('Handler error:', error.message);
    return res.status(500).json({ error: 'Generation failed', detail: error.message });
  }
}