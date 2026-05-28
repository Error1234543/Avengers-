const API_KEYS = [
  process.env.GROQ_API_KEY_1,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3,
].filter(Boolean);

async function callGroqWithRotation(body) {
  for (let i = 0; i < API_KEYS.length; i++) {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${API_KEYS[i]}`
        },
        body: JSON.stringify(body)
      });
      if (response.status === 429) {
        console.log(`Key ${i + 1} rate limited, trying next...`);
        continue;
      }
      return response;
    } catch (err) {
      console.error(`Key ${i + 1} error:`, err.message);
      continue;
    }
  }
  return null;
}

// Daily usage store (in-memory — resets on server restart, fine for Vercel)
const dailyUsage = {};
function getDailyKey(userId) {
  return `${userId}_${new Date().toISOString().slice(0, 10)}`;
}
function checkUsage(userId, limit) {
  const key = getDailyKey(userId);
  const current = dailyUsage[key] || 0;
  if (current >= limit) return { allowed: false, used: current, limit };
  dailyUsage[key] = current + 1;
  return { allowed: true, used: current + 1, limit };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { topic, numQ, difficulty, language, exam, subject, userId, userPlan } = req.body;

  if (!topic || !numQ) return res.status(400).json({ error: 'Missing fields' });
  if (API_KEYS.length === 0) return res.status(500).json({ error: 'No API keys configured' });

  // ── PLAN SETTINGS ──────────────────────────────────────────────────
  // userPlan: 'free' | 'pro'
  // pro = ₹300/month → 20 quizzes/day, max 100 MCQ
  // free = 3 trials total (handled in frontend), max 5 MCQ
  const isPro = userPlan === 'pro';
  const DAILY_LIMIT = isPro ? 20 : 999; // free trials handled in frontend
  
  const uid = userId || req.headers['x-forwarded-for'] || 'anonymous';
  if (isPro) {
    const usage = checkUsage(uid, DAILY_LIMIT);
    if (!usage.allowed) {
      return res.status(429).json({
        error: `Daily limit khatam! Aaj ke 20 quizzes ho gaye. Kal reset hoga. 🌙`,
        used: usage.used,
        limit: usage.limit
      });
    }
  }

  // ── LANGUAGE & MODEL SETTINGS ──────────────────────────────────────
  const isGuj = language === 'Gujarati';
  const isHin = language === 'Hindi';
  const isIndic = isGuj || isHin;
  const total = parseInt(numQ);
  const isFiveOnly = total <= 5; // Free users / small requests

  // Small requests (5 MCQ) = fast cheap model
  // Large requests (100 MCQ) = better model for quality
  const MODEL = isFiveOnly
    ? 'llama-3.1-8b-instant'       // Fast + cheap for 5 MCQ
    : 'llama-3.3-70b-versatile';   // Best quality for 100 MCQ

  const langInstruction = isGuj
    ? `IMPORTANT: Write EVERY SINGLE WORD in Gujarati script (ગુજરાતી લિપિ) ONLY.
- Questions must be in Gujarati.
- All 4 options must be in Gujarati.
- Explanation must be in Gujarati.
- Do NOT use any English words anywhere.
- Use proper Gujarati grammar and spelling.`
    : isHin
    ? `IMPORTANT: Write EVERY SINGLE WORD in Hindi (हिंदी) ONLY. No English words anywhere.`
    : `Write everything in clear English.`;

  // Batch size: Gujarati needs smaller batches (more tokens per question)
  // 20 for English, 10 for Gujarati/Hindi to avoid JSON cutoff
  // Gujarati heavy topics = 5 per batch, Hindi = 7, English = 20
  const BATCH_SIZE = isGuj ? 5 : isHin ? 7 : 20;
  const MAX_TOKENS = isGuj ? 8000 : isHin ? 7000 : 6000;

  const totalBatches = Math.ceil(total / BATCH_SIZE);
  let allQuestions = [];

  try {
    for (let batch = 0; batch < totalBatches; batch++) {
      const batchCount = Math.min(BATCH_SIZE, total - allQuestions.length);
      const startNum = allQuestions.length + 1;
      let batchSuccess = false;
      let retryCount = 0;
      const MAX_RETRIES = 3;

      while (!batchSuccess && retryCount < MAX_RETRIES) {
        if (retryCount > 0) {
          console.log(`Batch ${batch + 1}: Retry ${retryCount}/${MAX_RETRIES}...`);
          await new Promise(r => setTimeout(r, 600 * retryCount));
        }

      const prompt = `Generate exactly ${batchCount} MCQ questions about "${topic}".
${langInstruction}
Difficulty: ${difficulty || 'medium'}.
Exam: ${exam || 'General'}, Subject: ${subject || 'General'}.
These are questions ${startNum} to ${startNum + batchCount - 1} in a set.

RULES (follow strictly):
1. Return ONLY a valid JSON array — no markdown, no backticks, no explanation text.
2. Each item: {"question":"...","options":["A","B","C","D"],"correct":0,"explanation":"..."}
3. "correct" = index 0,1,2,3 of the correct option.
4. All 4 options must be unique and meaningful.
5. Questions must be different from each other.

Return ONLY the JSON array starting with [ and ending with ]`;

      const response = await callGroqWithRotation({
        model: MODEL,
        messages: [
          {
            role: 'system',
            content: `You are an expert MCQ generator for JEE, NEET, GUJCET exams. ${langInstruction}
CRITICAL: Respond with ONLY a valid JSON array. No text before [. No text after ]. No markdown.`
          },
          { role: 'user', content: prompt }
        ],
        temperature: 0.4,
        max_tokens: MAX_TOKENS
      });

      // Retry logic — 2 extra attempts per batch
      if (!response || !response.ok) {
        const errText = response ? await response.text() : 'All keys failed';
        console.error(`Batch ${batch + 1} failed: ${errText}`);
        retryCount++; continue;
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content?.trim();
      if (!content) { console.error(`Batch ${batch + 1}: Empty`); retryCount++; continue; }

      const arrayStart = content.indexOf('[');
      const arrayEnd = content.lastIndexOf(']');
      if (arrayStart === -1 || arrayEnd === -1) {
        console.error(`Batch ${batch + 1}: No JSON array. Got: ${content.substring(0, 150)}`);
        retryCount++; continue;
      }

      let jsonStr = content.substring(arrayStart, arrayEnd + 1)
        .replace(/,\s*]/g, ']')
        .replace(/,\s*}/g, '}')
        .replace(/[\x00-\x1F\x7F]/g, ' ');

      let questions;
      try {
        questions = JSON.parse(jsonStr);
      } catch (e) {
        console.error(`Batch ${batch + 1} parse error:`, e.message);
        retryCount++; continue;
      }

      if (!Array.isArray(questions)) continue;

      const valid = questions
        .filter(q => q.question && q.question.length > 3)
        .map((q, idx) => ({
          id: allQuestions.length + idx + 1,
          question: q.question,
          options: Array.isArray(q.options) && q.options.length >= 4
            ? q.options.slice(0, 4)
            : ['Option A', 'Option B', 'Option C', 'Option D'],
          correct: typeof q.correct === 'number' && q.correct >= 0 && q.correct <= 3
            ? q.correct : 0,
          explanation: q.explanation || '',
          difficulty: difficulty || 'medium'
        }));

      allQuestions = [...allQuestions, ...valid];
      console.log(`Batch ${batch + 1}/${totalBatches}: +${valid.length} | Total: ${allQuestions.length}/${total}`);
        batchSuccess = true; // batch parsed OK
        break;
      } // end while retry

      if (batch < totalBatches - 1) await new Promise(r => setTimeout(r, 400));
    }

    if (allQuestions.length === 0) {
      return res.status(500).json({ error: 'Questions generate nahi hue. Topic change karke try karo.' });
    }

    const usageInfo = isPro ? checkUsage(uid, DAILY_LIMIT) : null;

    return res.status(200).json({
      title: `${exam || topic} — ${subject || topic}`,
      generated: allQuestions.length,
      requested: total,
      dailyUsed: usageInfo?.used || 0,
      dailyLimit: DAILY_LIMIT,
      questions: allQuestions.slice(0, total)
    });

  } catch (error) {
    console.error('Handler error:', error.message);
    return res.status(500).json({ error: 'Generation failed. Please try again.' });
  }
}
