
// ============================================================
// File: /api/generate.js
// Stable MCQ Generator for Vercel + Groq
// ============================================================

const API_KEYS = [
  process.env.GROQ_API_KEY_1,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3,
].filter(Boolean);

// ============================================================
// API KEY ROTATION
// ============================================================

async function callGroqWithRotation(body) {
  for (let i = 0; i < API_KEYS.length; i++) {
    const apiKey = API_KEYS[i];

    try {
      const response = await fetch(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          method: 'POST',

          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },

          body: JSON.stringify(body),
        }
      );

      // Rate Limited
      if (response.status === 429) {
        console.log(
          `API Key ${i + 1} Rate Limited → Trying Next Key`
        );

        continue;
      }

      return response;
    } catch (err) {
      console.error(
        `API Key ${i + 1} Error:`,
        err.message
      );

      continue;
    }
  }

  return null;
}

// ============================================================
// MAIN API
// ============================================================

export default async function handler(req, res) {
  // ============================================================
  // METHOD CHECK
  // ============================================================

  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Method not allowed',
    });
  }

  // ============================================================
  // REQUEST BODY
  // ============================================================

  const {
    topic,
    numQ,
    difficulty,
    language,
    exam,
    subject,
  } = req.body;

  // ============================================================
  // VALIDATION
  // ============================================================

  if (!topic || !numQ) {
    return res.status(400).json({
      error: 'Missing required fields',
    });
  }

  if (API_KEYS.length === 0) {
    return res.status(500).json({
      error: 'No API keys configured',
    });
  }

  // ============================================================
  // LANGUAGE INSTRUCTIONS
  // ============================================================

  const langInstruction =
    language === 'Gujarati'
      ? 'IMPORTANT: Write ALL text strictly in Gujarati script (ગુજરાતી). No English words at all.'
      : language === 'Hindi'
      ? 'IMPORTANT: Write ALL text strictly in Hindi (हिंदी). No English words at all.'
      : 'Write everything in English.';

  // ============================================================
  // SETTINGS
  // ============================================================

  const total = parseInt(numQ);

  // Stable Batch Size
  const BATCH_SIZE = 10;

  // Stable Tokens
  const MAX_TOKENS = 3000;

  const totalBatches = Math.ceil(total / BATCH_SIZE);

  let allQuestions = [];

  // Duplicate Prevention
  const seenQuestions = new Set();

  // ============================================================
  // START GENERATION
  // ============================================================

  try {
    for (let batch = 0; batch < totalBatches; batch++) {
      // ========================================================
      // CURRENT BATCH COUNT
      // ========================================================

      const batchCount = Math.min(
        BATCH_SIZE,
        total - allQuestions.length
      );

      console.log(
        `Generating Batch ${batch + 1}/${totalBatches}`
      );

      // ========================================================
      // PROMPT
      // ========================================================

      const prompt = `
Generate exactly ${batchCount} UNIQUE MCQ questions about "${topic}".

This is batch ${batch + 1} of ${totalBatches}.

${langInstruction}

Difficulty:
${difficulty || 'medium'}

Exam:
${exam || 'General'}

Subject:
${subject || 'General'}

STRICT RULES:
- Return ONLY valid JSON array
- No markdown
- No backticks
- No explanation outside JSON
- Do NOT repeat previous questions
- Each question must contain:
  question
  options
  correct
  explanation

- Exactly 4 options required
- correct must be:
  0 or 1 or 2 or 3

JSON FORMAT:

[
  {
    "question":"...",
    "options":["...","...","...","..."],
    "correct":0,
    "explanation":"..."
  }
]
`;

      // ========================================================
      // API CALL
      // ========================================================

      const response = await callGroqWithRotation({
        model: 'llama3-70b-8192',

        messages: [
          {
            role: 'system',

            content: `
You are a professional MCQ generator.

${langInstruction}

Always respond ONLY with valid JSON array.
Never use markdown.
Never explain anything outside JSON.
`,
          },

          {
            role: 'user',
            content: prompt,
          },
        ],

        temperature: 0.4,

        max_tokens: MAX_TOKENS,
      });

      // ========================================================
      // API ERROR
      // ========================================================

      if (!response || !response.ok) {
        const errText = response
          ? await response.text()
          : 'All API keys failed';

        console.error(
          `Batch ${batch + 1} API Error:`,
          errText
        );

        continue;
      }

      // ========================================================
      // RESPONSE JSON
      // ========================================================

      const data = await response.json();

      const content =
        data?.choices?.[0]?.message?.content?.trim();

      console.log(content);

      if (!content) {
        console.error(
          `Batch ${batch + 1}: Empty Response`
        );

        continue;
      }

      // ========================================================
      // EXTRACT JSON
      // ========================================================

      const arrayStart = content.indexOf('[');

      const arrayEnd = content.lastIndexOf(']');

      if (arrayStart === -1 || arrayEnd === -1) {
        console.error(
          `Batch ${batch + 1}: JSON Array Not Found`
        );

        continue;
      }

      let jsonStr = content
        .substring(arrayStart, arrayEnd + 1)
        .replace(/```json/g, '')
        .replace(/```/g, '')
        .trim();

      // Fix Broken Commas
      jsonStr = jsonStr
        .replace(/,\s*]/g, ']')
        .replace(/,\s*}/g, '}');

      // ========================================================
      // PARSE JSON
      // ========================================================

      let questions = [];

      try {
        questions = JSON.parse(jsonStr);
      } catch (e) {
        console.error(
          `Batch ${batch + 1} Parse Error:`,
          e.message
        );

        continue;
      }

      // ========================================================
      // VALIDATE ARRAY
      // ========================================================

      if (!Array.isArray(questions)) {
        console.error(
          `Batch ${batch + 1}: Response Not Array`
        );

        continue;
      }

      // ========================================================
      // VALIDATE QUESTIONS
      // ========================================================

      const validQuestions = questions
        .filter((q) => {
          if (!q.question) return false;

          const cleanQuestion = q.question
            .trim()
            .toLowerCase();

          // Remove Duplicates
          if (seenQuestions.has(cleanQuestion)) {
            return false;
          }

          seenQuestions.add(cleanQuestion);

          return true;
        })

        .map((q, idx) => ({
          id: allQuestions.length + idx + 1,

          question: q.question,

          options:
            Array.isArray(q.options) &&
            q.options.length >= 4
              ? q.options.slice(0, 4)
              : [
                  'Option A',
                  'Option B',
                  'Option C',
                  'Option D',
                ],

          correct:
            typeof q.correct === 'number' &&
            q.correct >= 0 &&
            q.correct <= 3
              ? q.correct
              : 0,

          explanation: q.explanation || '',

          difficulty: difficulty || 'medium',
        }));

      // ========================================================
      // SAVE QUESTIONS
      // ========================================================

      allQuestions = [
        ...allQuestions,
        ...validQuestions,
      ];

      console.log(
        `Batch ${batch + 1} Added ${validQuestions.length} Questions`
      );

      console.log(
        `Current Total: ${allQuestions.length}`
      );

      // ========================================================
      // SMALL DELAY
      // ========================================================

      if (batch < totalBatches - 1) {
        await new Promise((r) => setTimeout(r, 700));
      }
    }

    // ============================================================
    // FINAL CHECK
    // ============================================================

    if (allQuestions.length === 0) {
      return res.status(500).json({
        error:
          'No questions generated. Try again later.',
      });
    }

    // ============================================================
    // SUCCESS RESPONSE
    // ============================================================

    return res.status(200).json({
      success: true,

      title: `${exam || topic} — ${
        subject || topic
      }`,

      requested: total,

      generated: allQuestions.length,

      questions: allQuestions.slice(0, total),
    });
  } catch (error) {
    console.error(
      'Handler Error:',
      error.message
    );

    return res.status(500).json({
      error: 'Generation failed. Please try again.',
    });
  }
}