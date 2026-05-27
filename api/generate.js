// ============================================================
// API Route for Vercel
// File: /api/generate.js
// ============================================================

const API_KEYS = [
  process.env.GROQ_API_KEY_1,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3,
].filter(Boolean);

// ============================================================
// Rotate API Keys Automatically
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

      // Rate limit → next key
      if (response.status === 429) {
        console.log(`Key ${i + 1} rate limited → trying next key`);
        continue;
      }

      return response;
    } catch (err) {
      console.error(`Key ${i + 1} fetch error:`, err.message);
      continue;
    }
  }

  return null;
}

// ============================================================
// Main API
// ============================================================

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Method not allowed',
    });
  }

  const {
    topic,
    numQ,
    difficulty,
    language,
    exam,
    subject,
  } = req.body;

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
  // Language Instructions
  // ============================================================

  const langInstruction =
    language === 'Gujarati'
      ? 'IMPORTANT: Write ALL text strictly in Gujarati script (ગુજરાતી). No English words.'
      : language === 'Hindi'
      ? 'IMPORTANT: Write ALL text strictly in Hindi (हिंदी). No English words.'
      : 'Write everything in English.';

  // ============================================================
  // Batch Settings
  // ============================================================

  const total = parseInt(numQ);

  // 25 questions per API call
  const BATCH_SIZE = 25;

  // High token limit
  const MAX_TOKENS = 8000;

  const totalBatches = Math.ceil(total / BATCH_SIZE);

  let allQuestions = [];

  // Duplicate prevention
  const seenQuestions = new Set();

  try {
    // ============================================================
    // Generate Batch by Batch
    // ============================================================

    for (let batch = 0; batch < totalBatches; batch++) {
      const batchCount = Math.min(
        BATCH_SIZE,
        total - allQuestions.length
      );

      console.log(
        `Generating Batch ${batch + 1}/${totalBatches}`
      );

      const prompt = `
Generate exactly ${batchCount} UNIQUE MCQ questions about "${topic}".

This is batch ${batch + 1} of ${totalBatches}.

IMPORTANT:
- Do NOT repeat previous questions
- Questions must be fully unique
- Questions must be exam-level quality

${langInstruction}

Difficulty Level:
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
- Each question must contain:
  question
  options
  correct
  explanation

- Exactly 4 options required
- "correct" must be:
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

      // ============================================================
      // API Call
      // ============================================================

      const response = await callGroqWithRotation({
        model: 'llama-3.1-8b-instant',

        messages: [
          {
            role: 'system',
            content: `
You are an expert MCQ generator.

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

      // ============================================================
      // API Error
      // ============================================================

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

      // ============================================================
      // Parse API Response
      // ============================================================

      const data = await response.json();

      const content =
        data?.choices?.[0]?.message?.content?.trim();

      if (!content) {
        console.error(
          `Batch ${batch + 1}: Empty response`
        );

        continue;
      }

      // ============================================================
      // Extract JSON
      // ============================================================

      const arrayStart = content.indexOf('[');

      const arrayEnd = content.lastIndexOf(']');

      if (arrayStart === -1 || arrayEnd === -1) {
        console.error(
          `Batch ${batch + 1}: No JSON found`
        );

        continue;
      }

      let jsonStr = content.substring(
        arrayStart,
        arrayEnd + 1
      );

      // Fix broken commas
      jsonStr = jsonStr
        .replace(/,\s*]/g, ']')
        .replace(/,\s*}/g, '}');

      // ============================================================
      // Convert JSON
      // ============================================================

      let questions = [];

      try {
        questions = JSON.parse(jsonStr);
      } catch (e) {
        console.error(
          `Batch ${batch + 1} JSON Parse Error:`,
          e.message
        );

        continue;
      }

      if (!Array.isArray(questions)) {
        continue;
      }

      // ============================================================
      // Validate Questions
      // ============================================================

      const validQuestions = questions
        .filter((q) => {
          if (!q.question) return false;

          const cleanQuestion = q.question
            .trim()
            .toLowerCase();

          // Remove duplicates
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

      // ============================================================
      // Save Batch
      // ============================================================

      allQuestions = [
        ...allQuestions,
        ...validQuestions,
      ];

      console.log(
        `Batch ${batch + 1} Complete → Added ${
          validQuestions.length
        } Questions`
      );

      console.log(
        `Current Total: ${allQuestions.length}`
      );

      // Small delay between batches
      if (batch < totalBatches - 1) {
        await new Promise((r) => setTimeout(r, 700));
      }
    }

    // ============================================================
    // Final Validation
    // ============================================================

    if (allQuestions.length === 0) {
      return res.status(500).json({
        error:
          'No questions generated. Try again later.',
      });
    }

    // ============================================================
    // Final Response
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
    console.error('Handler Error:', error.message);

    return res.status(500).json({
      error: 'Generation failed. Please try again.',
    });
  }
}