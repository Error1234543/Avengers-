// ============================================================
// API Route for Vercel
// ============================================================

const groqApiKey = process.env.GROQ_API_KEY;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { topic, numQ, difficulty, language, exam, subject } = req.body;

    if (!topic || !numQ || !difficulty || !language || !exam || !subject) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (!groqApiKey) {
      return res.status(500).json({ error: 'API key not configured' });
    }

    // ================= CONFIG =================
    const BATCH_SIZE = 25;
    const totalBatches = Math.ceil(numQ / BATCH_SIZE);

    let allQuestions = [];

    // ================= LANGUAGE =================
    let langInstr = '';
    if (language === 'Gujarati') {
      langInstr = 'Write everything in Gujarati (ગુજરાતી).';
    } else if (language === 'Hindi') {
      langInstr = 'Write everything in Hindi (हिंदी).';
    }

    // ================= EXAM =================
    let examInstr = '';
    if (exam === 'JEE Mains') examInstr = 'JEE Mains level conceptual questions.';
    else if (exam === 'JEE Advanced') examInstr = 'Advanced tricky conceptual questions.';
    else if (exam === 'NEET') examInstr = 'NCERT-based NEET questions.';
    else if (exam === 'GUJCET') examInstr = 'Gujarat board level questions.';
    else if (exam === 'Board Exam') examInstr = 'Standard board exam level.';

    // ================= LOOP BATCH =================
    for (let i = 0; i < totalBatches; i++) {

      const currentNum = Math.min(BATCH_SIZE, numQ - i * BATCH_SIZE);

      const prompt = `
You are an expert ${exam} question setter.

Generate exactly ${currentNum} MCQ questions.

Exam: ${exam}
Subject: ${subject}
Topic: "${topic}"
Difficulty: ${difficulty}

${examInstr}
${langInstr}

RULES:
- ONLY valid JSON
- NO markdown
- NO extra text
- explanation max 1-2 lines

Return format:
{
  "questions": [
    {
      "id": 1,
      "question": "",
      "options": ["A","B","C","D"],
      "correct": 0,
      "explanation": ""
    }
  ]
}
`;

      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${groqApiKey}`
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.6,
          max_tokens: 4096
        })
      });

      if (!groqRes.ok) {
        console.log("Batch failed:", i);
        continue;
      }

      const groqData = await groqRes.json();
      let raw = groqData.choices?.[0]?.message?.content || '';

      raw = raw.replace(/```json|```/g, '').trim();

      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');

      if (start === -1 || end === -1) continue;

      try {
        const parsed = JSON.parse(raw.substring(start, end + 1));

        if (parsed.questions && Array.isArray(parsed.questions)) {
          // fix ID numbering globally
          parsed.questions.forEach(q => {
            allQuestions.push({
              ...q,
              id: allQuestions.length + 1
            });
          });
        }

      } catch (e) {
        console.log("JSON Error in batch", i);
      }
    }

    // ================= FINAL RESPONSE =================
    return res.status(200).json({
      title: topic,
      total: allQuestions.length,
      expected: numQ,
      batchSize: BATCH_SIZE,
      questions: allQuestions
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}