export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { topic, numQ, difficulty, language, exam, subject } = req.body;

    if (!topic || !numQ || !difficulty || !language || !exam || !subject) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const groqApiKey = process.env.GROQ_API_KEY;
    if (!groqApiKey) {
      return res.status(500).json({ error: 'API key not configured on server' });
    }

    // Build language instruction
    let langInstr = '';
    if (language === 'Gujarati') {
      langInstr = 'IMPORTANT: Write ALL questions, options, and explanations in Gujarati script (ગુજરાતી). Chemical formulas and numbers stay in English.';
    } else if (language === 'Hindi') {
      langInstr = 'IMPORTANT: Write ALL questions, options, and explanations in Hindi (हिंदी). Formulas and numbers stay in English.';
    }

    // Build exam instruction
    let examInstr = 'Follow standard exam pattern.';
    if (exam === 'JEE Mains') {
      examInstr = 'Follow JEE Mains pattern: conceptual, numerical, and application-based single correct answer questions.';
    } else if (exam === 'JEE Advanced') {
      examInstr = 'Follow JEE Advanced pattern: deep conceptual understanding, multi-concept, tricky questions.';
    } else if (exam === 'NEET') {
      examInstr = 'Follow NEET pattern: NCERT-based, factual and conceptual questions suitable for medical entrance.';
    } else if (exam === 'GUJCET') {
      examInstr = 'Follow GUJCET Gujarat board exam pattern and difficulty level.';
    } else if (exam === 'Board Exam') {
      examInstr = 'Standard board exam level questions.';
    }

    const prompt = `You are an expert ${exam} question paper setter for Indian competitive exams.

Generate exactly ${numQ} unique, high-quality MCQ questions.

Exam: ${exam}
Subject: ${subject}
Topic: "${topic}"
Difficulty Level: ${difficulty}

${examInstr}
${langInstr}

CRITICAL REQUIREMENTS:
- Cover ALL subtopics and aspects of "${topic}"
- Make each question unique and educational
- Ensure only ONE correct answer per question
- Write clear, exam-standard explanations

Return ONLY valid, properly formatted JSON. No markdown, no backticks, no extra text before or after JSON:

{
  "title": "Topic-based Quiz Title",
  "questions": [
    {
      "id": 1,
      "question": "Complete question text with all details?",
      "difficulty": "${difficulty === 'mixed' ? 'medium' : difficulty}",
      "options": ["First option text", "Second option text", "Third option text", "Fourth option text"],
      "correct": 0,
      "explanation": "Clear explanation of why this is the correct answer in 2-3 sentences."
    }
  ]
}

Notes:
- "correct" field must be 0-indexed: 0=A, 1=B, 2=C, 3=D
- Each question must have exactly 4 options
- Explanations should be educational and concise
- Return ONLY the JSON object, nothing else`;

    // Call Groq API
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${groqApiKey}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.7,
        max_tokens: 3000,
        top_p: 0.95
      })
    });

    if (!groqRes.ok) {
      const errData = await groqRes.json();
      console.error('Groq API Error:', errData);

      if (groqRes.status === 401) {
        return res.status(401).json({ error: 'Invalid Groq API key' });
      }
      if (groqRes.status === 429) {
        return res.status(429).json({ error: 'Rate limit exceeded. Please retry after 1 minute.' });
      }
      if (groqRes.status === 400) {
        return res.status(400).json({ error: 'Invalid request to API' });
      }

      return res.status(groqRes.status).json({
        error: errData.error?.message || 'Groq API error'
      });
    }

    const groqData = await groqRes.json();
    
    if (!groqData.choices || !groqData.choices[0] || !groqData.choices[0].message) {
      return res.status(500).json({ error: 'Invalid response structure from API' });
    }

    let rawResponse = groqData.choices[0].message.content;

    // Clean up response
    rawResponse = rawResponse.trim();
    
    // Remove markdown code blocks if present
    rawResponse = rawResponse.replace(/```json\n?/g, '');
    rawResponse = rawResponse.replace(/```\n?/g, '');
    rawResponse = rawResponse.trim();

    // Find JSON boundaries
    const jsonStart = rawResponse.indexOf('{');
    const jsonEnd = rawResponse.lastIndexOf('}');

    if (jsonStart === -1 || jsonEnd === -1) {
      console.error('JSON boundaries not found in response:', rawResponse.substring(0, 200));
      return res.status(500).json({
        error: 'Could not parse MCQ data. Response format invalid.'
      });
    }

    let jsonStr = rawResponse.substring(jsonStart, jsonEnd + 1);

    // Fix common JSON issues
    // Remove trailing commas before ] and }
    jsonStr = jsonStr.replace(/,(\s*[\]\}])/g, '$1');
    
    // Fix quotes if needed
    jsonStr = jsonStr.replace(/[\u2018\u2019]/g, "'");
    jsonStr = jsonStr.replace(/[\u201C\u201D]/g, '"');

    let quiz;
    try {
      quiz = JSON.parse(jsonStr);
    } catch (parseErr) {
      console.error('JSON Parse Error:', parseErr.message);
      console.error('Problem JSON:', jsonStr.substring(0, 500));
      return res.status(500).json({
        error: 'MCQ data format error. Please try again.'
      });
    }

    // Validate quiz structure
    if (!quiz.title || !Array.isArray(quiz.questions) || quiz.questions.length === 0) {
      return res.status(500).json({
        error: 'Invalid quiz structure received'
      });
    }

    // Validate each question
    for (let q of quiz.questions) {
      if (!q.question || !Array.isArray(q.options) || q.options.length !== 4) {
        return res.status(500).json({
          error: 'Question format error'
        });
      }
      if (typeof q.correct !== 'number' || q.correct < 0 || q.correct > 3) {
        q.correct = 0; // Default to first option if invalid
      }
    }

    return res.status(200).json(quiz);

  } catch (err) {
    console.error('Server Error:', err.message);
    return res.status(500).json({
      error: 'Server error: ' + err.message
    });
  }
}
