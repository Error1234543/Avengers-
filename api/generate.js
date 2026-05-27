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
      return res.status(500).json({ error: 'API key not configured' });
    }

    // Split large requests into chunks
    let chunksToFetch = 1;
    let questionsPerChunk = Math.min(numQ, 25); // Max 25 per chunk
    
    if (numQ > 25) {
      chunksToFetch = Math.ceil(numQ / 25);
      questionsPerChunk = Math.ceil(numQ / chunksToFetch);
    }

    const allQuestions = [];
    const chunkPromises = [];

    // Create promise for each chunk
    for (let chunk = 0; chunk < chunksToFetch; chunk++) {
      const promise = generateChunk(
        groqApiKey,
        topic,
        questionsPerChunk,
        difficulty,
        language,
        exam,
        subject,
        chunk + 1,
        chunksToFetch
      ).then(questions => {
        allQuestions.push(...questions);
      });
      chunkPromises.push(promise);
    }

    // Wait for all chunks
    await Promise.all(chunkPromises);

    // Trim to exact number if needed
    allQuestions.splice(numQ);

    // Re-index questions
    allQuestions.forEach((q, i) => {
      q.id = i + 1;
    });

    const quiz = {
      title: `${exam} - ${subject} - ${topic}`,
      questions: allQuestions
    };

    return res.status(200).json(quiz);

  } catch (err) {
    console.error('Server Error:', err.message);
    return res.status(500).json({
      error: 'Server error: ' + err.message
    });
  }
}

async function generateChunk(
  groqApiKey,
  topic,
  questionsPerChunk,
  difficulty,
  language,
  exam,
  subject,
  chunkNum,
  totalChunks
) {
  let langInstr = '';
  if (language === 'Gujarati') {
    langInstr = 'Write ALL in Gujarati script (ગુજરાતી). Formulas in English.';
  } else if (language === 'Hindi') {
    langInstr = 'Write ALL in Hindi (हिंदी). Formulas in English.';
  }

  let examInstr = 'Follow standard exam pattern.';
  if (exam === 'JEE Mains') {
    examInstr = 'JEE Mains: conceptual, numerical, application-based.';
  } else if (exam === 'JEE Advanced') {
    examInstr = 'JEE Advanced: deep conceptual, tricky, multi-concept.';
  } else if (exam === 'NEET') {
    examInstr = 'NEET: NCERT-based, factual and conceptual.';
  } else if (exam === 'GUJCET') {
    examInstr = 'GUJCET Gujarat board pattern.';
  }

  const prompt = `Generate exactly ${questionsPerChunk} unique MCQ questions (Chunk ${chunkNum}/${totalChunks}).

Topic: "${topic}"
Exam: ${exam}
Subject: ${subject}
Difficulty: ${difficulty}

${examInstr}
${langInstr}

IMPORTANT:
- Each question must be UNIQUE and different from others
- Cover different aspects of "${topic}"
- Ensure only ONE correct answer per question

Return ONLY valid JSON (no markdown, no text before/after):

{
  "questions": [
    {
      "id": ${(chunkNum - 1) * questionsPerChunk + 1},
      "question": "Question text?",
      "difficulty": "${difficulty === 'mixed' ? 'medium' : difficulty}",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "correct": 0,
      "explanation": "Brief explanation of correct answer."
    }
  ]
}`;

  try {
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
        max_tokens: 2000,
        top_p: 0.95
      })
    });

    if (!groqRes.ok) {
      const errData = await groqRes.json();
      console.error(`Chunk ${chunkNum} Error:`, errData);

      if (groqRes.status === 429) {
        // Rate limit - retry after delay
        await new Promise(resolve => setTimeout(resolve, 2000));
        return generateChunk(
          groqApiKey,
          topic,
          questionsPerChunk,
          difficulty,
          language,
          exam,
          subject,
          chunkNum,
          totalChunks
        );
      }

      throw new Error(`API Error: ${errData.error?.message || groqRes.status}`);
    }

    const groqData = await groqRes.json();
    let rawResponse = groqData.choices[0].message.content;

    // Clean response
    rawResponse = rawResponse.trim();
    rawResponse = rawResponse.replace(/```json\n?/g, '').replace(/```\n?/g, '');

    const jsonStart = rawResponse.indexOf('{');
    const jsonEnd = rawResponse.lastIndexOf('}');

    if (jsonStart === -1 || jsonEnd === -1) {
      throw new Error('JSON not found in response');
    }

    let jsonStr = rawResponse.substring(jsonStart, jsonEnd + 1);
    jsonStr = jsonStr.replace(/,(\s*[\]\}])/g, '$1');
    jsonStr = jsonStr.replace(/[\u2018\u2019]/g, "'");
    jsonStr = jsonStr.replace(/[\u201C\u201D]/g, '"');

    const data = JSON.parse(jsonStr);

    if (!Array.isArray(data.questions)) {
      throw new Error('Invalid questions array');
    }

    return data.questions;

  } catch (err) {
    console.error(`Error generating chunk ${chunkNum}:`, err);
    throw err;
  }
}
