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
      return res.status(500).json({ error: 'API key not configured' });
    }

    // Chunk size - never exceed 20 questions per request
    const CHUNK_SIZE = 20;
    const totalChunks = Math.ceil(numQ / CHUNK_SIZE);
    const allQuestions = [];

    // Generate questions in chunks
    for (let chunk = 0; chunk < totalChunks; chunk++) {
      const questionsInChunk = Math.min(CHUNK_SIZE, numQ - (chunk * CHUNK_SIZE));
      
      const chunkQuestions = await fetchChunk(
        groqApiKey,
        topic,
        questionsInChunk,
        difficulty,
        language,
        exam,
        subject,
        chunk + 1,
        totalChunks
      );

      allQuestions.push(...chunkQuestions);
    }

    // Re-index
    allQuestions.forEach((q, i) => {
      q.id = i + 1;
    });

    return res.status(200).json({
      title: `${exam} - ${subject} - ${topic}`,
      questions: allQuestions.slice(0, numQ)
    });

  } catch (err) {
    console.error('Error:', err.message);
    return res.status(500).json({ error: 'Failed to generate questions. Please try again.' });
  }
}

async function fetchChunk(groqApiKey, topic, numQ, difficulty, language, exam, subject, chunkNum, totalChunks) {
  let langInstr = '';
  if (language === 'Gujarati') {
    langInstr = 'IMPORTANT: Write ONLY in Gujarati script (ગુજરાતી). Chemical names and formulas can be in English.';
  } else if (language === 'Hindi') {
    langInstr = 'IMPORTANT: Write ONLY in Hindi (हिंदी). Chemical names and formulas can be in English.';
  }

  let examInstr = '';
  if (exam === 'JEE Mains') examInstr = 'JEE Mains pattern: conceptual, numerical problems, application-based.';
  else if (exam === 'JEE Advanced') examInstr = 'JEE Advanced: deep concepts, tricky questions, multi-concept.';
  else if (exam === 'NEET') examInstr = 'NEET pattern: NCERT-based, factual and conceptual questions.';
  else if (exam === 'GUJCET') examInstr = 'GUJCET pattern: Gujarat board standard.';
  else examInstr = 'Standard exam pattern questions.';

  const systemPrompt = `You are an expert ${exam} question setter. Generate exactly ${numQ} MCQ questions.
Return ONLY a valid JSON array with NO extra text, NO markdown, NO explanation outside JSON.
Each question must have exactly 4 options.
The "correct" field must be 0, 1, 2, or 3 (the index of the correct option).`;

  const userPrompt = `Generate ${numQ} unique MCQ questions for ${exam} exam (Chunk ${chunkNum}/${totalChunks}).

Topic: ${topic}
Subject: ${subject}  
Difficulty: ${difficulty}
Language: ${language}

${examInstr}
${langInstr}

Return ONLY this JSON array structure - nothing else:
[
  {
    "question": "Complete question text here?",
    "options": ["Option A text", "Option B text", "Option C text", "Option D text"],
    "correct": 0,
    "explanation": "Why this option is correct."
  }
]

Rules:
- Return ONLY the JSON array
- No markdown backticks
- No text before or after JSON
- Exactly 4 options per question
- correct field: 0-3 only
- No trailing commas`;

  const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${groqApiKey}`
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.5,
      max_tokens: 1500,
      top_p: 0.9
    })
  });

  if (!groqRes.ok) {
    const errData = await groqRes.json();
    console.error(`Chunk ${chunkNum} API error:`, errData);
    
    if (groqRes.status === 429) {
      // Rate limit - wait and retry
      await sleep(2000);
      return fetchChunk(groqApiKey, topic, numQ, difficulty, language, exam, subject, chunkNum, totalChunks);
    }
    
    throw new Error(`API Error: ${groqRes.status}`);
  }

  const data = await groqRes.json();
  let content = data.choices[0].message.content.trim();

  // Remove markdown code blocks
  content = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

  // If wrapped in object, extract array
  if (content.startsWith('{') && content.includes('"questions"')) {
    const obj = JSON.parse(content);
    content = JSON.stringify(obj.questions);
  }

  // Clean common issues
  content = content.replace(/,\s*]/g, ']');  // Remove trailing commas in arrays
  content = content.replace(/,\s*}/g, '}');  // Remove trailing commas in objects
  content = content.replace(/[\u2018\u2019]/g, "'");  // Fix smart quotes
  content = content.replace(/[\u201C\u201D]/g, '"');  // Fix smart double quotes

  // Ensure it's an array
  if (!content.startsWith('[')) {
    content = '[' + content + ']';
  }

  let questions = [];
  try {
    questions = JSON.parse(content);
  } catch (parseErr) {
    console.error(`Parse error in chunk ${chunkNum}:`, parseErr.message);
    console.error('Content start:', content.substring(0, 200));
    
    // Try to salvage
    try {
      const arrayContent = content.replace(/^{[\s\S]*?"questions"\s*:\s*/, '').replace(/\}$/, '');
      questions = JSON.parse(arrayContent);
    } catch (e) {
      throw new Error(`Failed to parse chunk ${chunkNum}`);
    }
  }

  if (!Array.isArray(questions)) {
    throw new Error(`Chunk ${chunkNum}: Not an array`);
  }

  // Validate and clean questions
  return questions.map((q, idx) => ({
    id: idx + 1,
    question: q.question || 'Question missing',
    difficulty: difficulty === 'mixed' ? 'medium' : difficulty,
    options: Array.isArray(q.options) && q.options.length === 4 
      ? q.options 
      : ['Option A', 'Option B', 'Option C', 'Option D'],
    correct: typeof q.correct === 'number' && q.correct >= 0 && q.correct <= 3 
      ? q.correct 
      : 0,
    explanation: q.explanation || 'Explanation not provided'
  }));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
