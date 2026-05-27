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

  try {
    const prompt = `Generate exactly ${numQ} MCQ questions about "${topic}".
Return ONLY a JSON array. No markdown, no text before/after.

[
  {
    "question": "Question text here?",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correct": 0,
    "explanation": "Why this is correct"
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
        temperature: 0.2,
        max_tokens: 800
      })
    });

    if (!response.ok) {
      throw new Error(`API Error: ${response.status}`);
    }

    const data = await response.json();
    let content = data.choices[0].message.content;

    // Clean content
    content = content.trim();
    content = content.replace(/```json\n?/g, '').replace(/```\n?/g, '');
    content = content.replace(/^[\s\n]*/, '').replace(/[\s\n]*$/, '');

    // Find and extract array
    const arrayStart = content.indexOf('[');
    const arrayEnd = content.lastIndexOf(']');

    if (arrayStart === -1 || arrayEnd === -1) {
      return res.status(400).json({ error: 'Invalid response format' });
    }

    let jsonArray = content.substring(arrayStart, arrayEnd + 1);

    // Fix JSON issues
    jsonArray = jsonArray.replace(/,\s*]/g, ']');
    jsonArray = jsonArray.replace(/,\s*}/g, '}');
    jsonArray = jsonArray.replace(/\n\s*/g, ' ');

    // Parse
    let questions;
    try {
      questions = JSON.parse(jsonArray);
    } catch (e) {
      return res.status(400).json({ error: 'Could not parse response' });
    }

    if (!Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ error: 'No questions generated' });
    }

    // Validate each question
    const validQuestions = questions.map((q, idx) => ({
      id: idx + 1,
      question: q.question || '',
      options: (Array.isArray(q.options) && q.options.length >= 4) ? q.options.slice(0, 4) : ['A', 'B', 'C', 'D'],
      correct: (typeof q.correct === 'number' && q.correct >= 0 && q.correct <= 3) ? q.correct : 0,
      explanation: q.explanation || '',
      difficulty: difficulty || 'medium'
    })).filter(q => q.question.length > 0);

    if (validQuestions.length === 0) {
      return res.status(400).json({ error: 'No valid questions' });
    }

    res.status(200).json({
      title: `${exam} - ${subject}`,
      questions: validQuestions.slice(0, numQ)
    });

  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: 'Generation failed' });
  }
}
