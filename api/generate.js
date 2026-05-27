export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { topic, numQ, difficulty, language, exam, subject } = req.body;

    if (!topic || !numQ || !difficulty || !language || !exam || !subject) {
      return res.status(400).json({ error: 'Missing fields' });
    }

    const groqApiKey = process.env.GROQ_API_KEY;
    if (!groqApiKey) {
      return res.status(500).json({ error: 'API key not set' });
    }

    const allQuestions = [];
    const CHUNK_SIZE = 15;
    const totalChunks = Math.ceil(numQ / CHUNK_SIZE);

    for (let chunk = 0; chunk < totalChunks; chunk++) {
      const qCount = Math.min(CHUNK_SIZE, numQ - chunk * CHUNK_SIZE);
      const questions = await generateQuestions(
        groqApiKey, 
        topic, 
        qCount, 
        difficulty, 
        language, 
        exam, 
        subject
      );
      allQuestions.push(...questions);
    }

    allQuestions.forEach((q, i) => q.id = i + 1);

    return res.status(200).json({
      title: `${exam} - ${subject}`,
      questions: allQuestions.slice(0, numQ)
    });

  } catch (err) {
    console.error('Error:', err);
    return res.status(500).json({ error: 'Question generation failed' });
  }
}

async function generateQuestions(apiKey, topic, count, difficulty, language, exam, subject) {
  let langLine = 'English';
  if (language === 'Gujarati') langLine = 'Gujarati (ગુજરાતી)';
  if (language === 'Hindi') langLine = 'Hindi (हिंदी)';

  const prompt = `Generate ${count} MCQ questions. Return ONLY valid JSON array, no other text.

Topic: ${topic}
Exam: ${exam}
Subject: ${subject}
Difficulty: ${difficulty}
Language: ${langLine}

Return as JSON array exactly like this (NO extra text, NO markdown):
[{"question":"Q text?","options":["A","B","C","D"],"correct":0,"explanation":"Why correct."}]`;

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 1200
      })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message || `Status ${res.status}`);
    }

    const data = await res.json();
    let text = data.choices[0].message.content.trim();

    text = text.replace(/```json\n?/g, '').replace(/```/g, '').trim();

    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    
    if (start === -1 || end === -1) {
      console.error('No JSON array found:', text.substring(0, 100));
      throw new Error('JSON not found');
    }

    text = text.substring(start, end + 1);

    text = text.replace(/,\s*]/g, ']');
    text = text.replace(/,\s*}/g, '}');
    text = text.replace(/\n/g, ' ');

    const questions = JSON.parse(text);

    if (!Array.isArray(questions)) throw new Error('Not an array');

    return questions.map(q => ({
      question: String(q.question || ''),
      options: Array.isArray(q.options) ? q.options.slice(0, 4) : ['A', 'B', 'C', 'D'],
      correct: Math.min(3, Math.max(0, parseInt(q.correct) || 0)),
      explanation: String(q.explanation || ''),
      difficulty: difficulty
    })).filter(q => q.question.length > 0);

  } catch (err) {
    console.error(`Chunk error: ${err.message}`);
    throw err;
  }
}