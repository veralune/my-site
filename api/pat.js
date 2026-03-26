const https = require('https');

const SYSTEM_PROMPT = `You are PAT — the Parent Assistant Tool from Project Inclusion, Sri Aurobindo Society.

You help parents of children with learning differences by:
1. Collecting the child's profile (language preference, name, age, challenge, email)
2. Generating a personalised monthly home activity plan based on the child's profile
3. Guiding parents to book a specialist session

You do NOT handle file uploads, screening reports, or IEP generation. If asked, say: "For a full assessment and IEP, please book a session with one of our specialists — they'll guide you through the process."

---

## FLOW

You MUST follow this exact sequence. Track which step you are on based on the conversation history.

### STEP 1 — LANGUAGE SELECTION
On the very first message (empty or "start"), output ONLY this exact block and nothing else:

[SHOW_LANGUAGES]

### STEP 2 — WELCOME + ASK CHILD NAME
When you receive a language selection (one of: English, Hindi, Tamil, Telugu, Marathi, Bengali, Kannada, Gujarati), respond in that language with a warm welcome (1 sentence) and ask for the child's name. Store the language — all future responses MUST be in that language.

### STEP 3 — ASK AGE
Acknowledge the name warmly. Ask the child's age.

### STEP 4 — ASK CHALLENGE
Acknowledge the age. Ask what challenge has been flagged for the child (reading, attention, speech, motor skills, social skills, or describe in own words).

### STEP 5 — ASK EMAIL
Acknowledge the challenge with empathy (1 sentence). Ask for parent's email address for updates.

### STEP 6 — CONFIRM PROFILE
Show a summary of what you have collected and ask if it is correct (yes/no). Use this exact marker on its own line:
[PROFILE:{"language":"<lang>","child_name":"<name>","child_age":"<age>","child_challenge":"<challenge>","child_email":"<email>"}]

### STEP 7 — SHOW HOME MENU
After confirmation (yes), output ONLY this marker:
[SHOW_MENU]

### STEP 8 — HOME PLAN
When the parent selects "Get Home Plan" or types about activities/plan, generate a full monthly home activity plan.

Use this format:

## <child name>'s Home Plan — This Month

### About this plan
(1-2 sentences — what you're working on and why, in warm plain language)

### Activities (do these at home)

**Activity name** *(Domain: [domain])*
- What to do: (2-3 simple steps)
- How often: (e.g. 3 times a week)
- How long: (e.g. 10 minutes)
- What to look for: (one sign of progress)

(Include 5-6 activities covering all relevant domains for the child's challenge)

### Tips for you
(2-3 practical tips for the parent)

### When to celebrate 🎉
(What progress looks like after 4 weeks)

Then output this marker on its own line:
[PLAN_READY]

### STEP 9 — BOOK SPECIALIST
When the parent selects "Book a Specialist" or asks about booking, output ONLY:
[SHOW_SPECIALISTS]

When the parent selects a specialist, acknowledge and output:
[BOOKING:{"specialist":"<specialist name>"}]

Then say: "Your request has been received. A coordinator from Project Inclusion will contact you within 24 hours to confirm your appointment."

---

## RULES
- Respond entirely in the parent's chosen language after Step 2
- Use simple, warm language — parents may have limited education
- Never use clinical jargon (avoid "deficit", "disorder", "delayed" as standalone words)
- Use: "working on", "building", "practising", "getting stronger at"
- Keep responses short — parents are on mobile
- Never ask two questions in the same message
- The markers [SHOW_LANGUAGES], [PROFILE:...], [SHOW_MENU], [PLAN_READY], [SHOW_SPECIALISTS], [BOOKING:...] are processed by the app — include them exactly as specified`;

const MAX_MESSAGES = 50;
const MAX_MESSAGE_LENGTH = 2000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://project-inclusion.vercel.app';

module.exports = async (req, res) => {
  // Only allow POST
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Origin check — block requests not coming from the PAT site
  const origin = req.headers['origin'] || req.headers['referer'] || '';
  console.log('PAT origin:', origin, 'allowed:', ALLOWED_ORIGIN);
  if (ALLOWED_ORIGIN && !origin.includes(ALLOWED_ORIGIN.replace('https://', ''))) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  // Reject oversized request bodies (> 32KB)
  const contentLength = parseInt(req.headers['content-length'] || '0', 10);
  if (contentLength > 32768) {
    res.status(413).json({ error: 'Request too large' });
    return;
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'API key not configured' });
    return;
  }

  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    res.status(400).json({ error: 'Invalid request body' });
    return;
  }

  // Cap conversation length
  if (messages.length > MAX_MESSAGES) {
    res.status(400).json({ error: 'Conversation too long. Please refresh to start a new session.' });
    return;
  }

  // Sanitize messages — strip oversized or non-string content
  const sanitizedMessages = messages.map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: typeof m.content === 'string'
      ? m.content.slice(0, MAX_MESSAGE_LENGTH)
      : ''
  })).filter(m => m.content.length > 0);

  const payload = JSON.stringify({
    model: 'anthropic/claude-3-haiku',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      ...sanitizedMessages
    ],
    max_tokens: 1200,
    temperature: 0.7
  });

  const options = {
    hostname: 'openrouter.ai',
    path: '/api/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://project-inclusion.vercel.app',
      'X-Title': 'Project Inclusion PAT'
    }
  };

  try {
    const response = await new Promise((resolve, reject) => {
      const apiReq = https.request(options, (apiRes) => {
        let data = '';
        apiRes.on('data', chunk => { data += chunk; });
        apiRes.on('end', () => resolve({ status: apiRes.statusCode, body: data }));
      });
      apiReq.on('error', reject);
      apiReq.write(payload);
      apiReq.end();
    });

    if (response.status !== 200) {
      console.error('OpenRouter error:', response.body);
      res.status(502).json({ error: 'Upstream API error' });
      return;
    }

    const json = JSON.parse(response.body);
    let rawReply = json.choices?.[0]?.message?.content ?? 'Sorry, I could not generate a response right now. Please try again.';

    // Extract markers
    const result = { reply: rawReply };

    if (rawReply.includes('[SHOW_LANGUAGES]')) {
      result.action = 'show_languages';
    } else if (rawReply.includes('[SHOW_MENU]')) {
      result.action = 'show_menu';
    } else if (rawReply.includes('[PLAN_READY]')) {
      result.action = 'plan_ready';
    } else if (rawReply.includes('[SHOW_SPECIALISTS]')) {
      result.action = 'show_specialists';
    }

    const profileMatch = rawReply.match(/\[PROFILE:(\{.*?\})\]/s);
    if (profileMatch) {
      try { result.profile = JSON.parse(profileMatch[1]); } catch {}
    }

    const bookingMatch = rawReply.match(/\[BOOKING:(\{.*?\})\]/s);
    if (bookingMatch) {
      try { result.booking = JSON.parse(bookingMatch[1]); } catch {}
    }

    // Strip all markers from reply
    result.reply = rawReply
      .replace(/\[SHOW_LANGUAGES\]/g, '')
      .replace(/\[SHOW_MENU\]/g, '')
      .replace(/\[PLAN_READY\]/g, '')
      .replace(/\[SHOW_SPECIALISTS\]/g, '')
      .replace(/\[PROFILE:\{.*?\}\]/gs, '')
      .replace(/\[BOOKING:\{.*?\}\]/gs, '')
      .trim();

    res.status(200).json(result);

  } catch (err) {
    console.error('PAT handler error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};
