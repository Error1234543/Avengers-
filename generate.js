// ============================================================
// API Route for Vercel
// Location: /api/generate.js
// This runs on Vercel server — API key is SAFE here!
// ============================================================

const groqApiKey = process.env.GROQ_API_KEY;

export default async function handler(req, res) {
  // Only POST allowed
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { topic, numQ, difficulty, language, exam, subject } = req.body;

    // Validate input
    if (!topic || !numQ || !difficulty || !language || !exam || !subject) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Check API key
    if (!groqApiKey) {
      return res.status(500).json({ error: 'API key not configured' });
    }

    // Build prompt
    let langInstr = '';
    if (language === 'Gujarati') {
      langInstr = 'Write ALL questions, options, and explanations in Gujarati script (ગુજરાતી). Chemical formulas and numbers stay in English.';
    } else if (language === 'Hindi') {
      langInstr = 'Write ALL questions, options, and explanations in Hindi (हिंदी). Formulas and numbers stay in English.';
    }

    let examInstr = '';
    if (exam === 'JEE Mains') examInstr = 'Follow JEE Mains: conceptual, numerical, application-based questions.';
    else if (exam === 'JEE Advanced') examInstr = 'Follow JEE Advanced: deep conceptual, tricky multi-concept questions.';
    else if (exam === 'NEET') examInstr = 'Follow NEET pattern: NCERT-based, factual and conceptual questions.';
    else if (exam === 'GUJCET') examInstr = 'Follow GUJCET Gujarat board pattern.';
    else if (exam === 'Board Exam') examInstr = 'Standard board exam level questions.';

    const prompt = `You are an expert ${exam} question paper setter.

Generate exactly ${numQ} MCQ questions.
Exam: ${exam}
Subject: ${subject}
Topic: "${topic}"
Difficulty: ${difficulty}
${examInstr}
${langInstr}

Cover ALL subtopics of "${topic}". Make each question unique and educational.

Return ONLY valid JSON — no markdown, no backticks:
{
  "title": "Topic as title",
  "questions": [
    {
      "id": 1,
      "question": "Question?",
      "difficulty": "${difficulty === 'mixed' ? 'medium' : difficulty}",
      "options": ["A", "B", "C", "D"],
      "correct": 0,
      "explanation": "Why correct. 2-3 sentences."
    }
  ]
}
correct = 0-indexed. Return ONLY JSON.`;

    // Call Groq API
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${groqApiKey}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: 8192
      })
    });

    if (!groqRes.ok) {
      const err = await groqRes.json();
      if (groqRes.status === 401) {
        return res.status(401).json({ error: 'Invalid Groq API key' });
      }
      if (groqRes.status === 429) {
        return res.status(429).json({ error: 'Rate limit exceeded. Try again in 1 minute.' });
      }
      return res.status(groqRes.status).json({ error: err.error?.message || 'Groq API error' });
    }

    const groqData = await groqRes.json();
    let raw = groqData.choices?.[0]?.message?.content || '';
    
    // Extract JSON
    raw = raw.replace(/```json|```/g, '').trim();
    const jsonStart = raw.indexOf('{');
    const jsonEnd = raw.lastIndexOf('}');
    if (jsonStart !== -1 && jsonEnd !== -1) {
      raw = raw.substring(jsonStart, jsonEnd + 1);
    }

    const quiz = JSON.parse(raw);

    // Return quiz
    res.status(200).json(quiz);

  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
