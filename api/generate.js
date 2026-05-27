export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { topic, numQ, difficulty, exam, subject } = req.body;

  console.log('=== REQUEST ===', { topic, numQ, difficulty });

  if (!topic || !numQ) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key missing' });
  }

  const BATCH_SIZE = 10;
  const total = parseInt(numQ);
  const totalBatches = Math.ceil(total / BATCH_SIZE);
  let allQuestions = [];

  try {
    for (let batch = 0; batch < totalBatches; batch++) {
      const batchCount = Math.min(BATCH_SIZE, total - allQuestions.length);

      console.log(`=== BATCH ${batch + 1}/${totalBatches} - Generating ${batchCount} MCQ ===`);

      const prompt = `Generate exactly ${batchCount} MCQ questions about "${topic}". Difficulty: ${difficulty || 'medium'}.

IMPORTANT: Return ONLY a JSON array, nothing else. No markdown, no backticks, no explanation.

Format:
[{"question":"Question here?","options":["A","B","C","D"],"correct":0,"explanation":"reason"}]`;

      let response;
      try {
        response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: 'llama-3.1-8b-instant',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.3,
            max_tokens: 1500
          })
        });
      } catch (fetchErr) {
        console.error(`Batch ${batch + 1} fetch failed:`, fetchErr.message);
        continue;
      }

      if (!response.ok) {
        const errText = await response.text();
        console.error(`Batch ${batch + 1} API error ${response.status}:`, errText);
        continue;
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content?.trim();

      console.log(`Batch ${batch + 1} raw response:`, content?.substring(0, 200));

      if (!content) {
        console.error(`Batch ${batch + 1}: Empty response`);
        continue;
      }

      // JSON extract karo
      const arrayStart = content.indexOf('[');
      const arrayEnd = content.lastIndexOf(']');

      if (arrayStart === -1 || arrayEnd === -1) {
        console.error(`Batch ${batch + 1}: No JSON array found in:`, content);
        continue;
      }

      let jsonStr = content.substring(arrayStart, arrayEnd + 1);

      let questions;
      try {
        questions = JSON.parse(jsonStr);
      } catch (parseErr) {
        console.error(`Batch ${batch + 1} parse error:`, parseErr.message);
        console.error('Raw JSON was:', jsonStr.substring(0, 300));
        continue;
      }

      if (!Array.isArray(questions)) continue;

      const valid = questions
        .filter(q => q.question && q.question.length > 5)
        .map((q, idx) => ({
          id: allQuestions.length + idx + 1,
          question: q.question,
          options: Array.isArray(q.options) && q.options.length >= 4
            ? q.options.slice(0, 4)
            : ['Option A', 'Option B', 'Option C', 'Option D'],
          correct: typeof q.correct === 'number' ? q.correct : 0,
          explanation: q.explanation || '',
          difficulty: difficulty || 'medium'
        }));

      console.log(`Batch ${batch + 1}: Got ${valid.length} valid questions`);
      allQuestions = [...allQuestions, ...valid];

      // Delay - rate limit se bachne ke liye
      if (batch < totalBatches - 1) {
        await new Promise(r => setTimeout(r, 800));
      }
    }

    console.log(`=== TOTAL: ${allQuestions.length}/${total} questions generated ===`);

    if (allQuestions.length === 0) {
      return res.status(500).json({ 
        error: 'No questions could be generated',
        hint: 'Check Vercel logs for details'
      });
    }

    return res.status(200).json({
      title: `${exam || topic} - ${subject || topic}`,
      generated: allQuestions.length,
      requested: total,
      questions: allQuestions.slice(0, total)
    });

  } catch (error) {
    console.error('=== HANDLER ERROR ===', error.message);
    return res.status(500).json({ error: 'Generation failed', detail: error.message });
  }
}