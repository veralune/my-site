const https = require('https');

const SYSTEM_PROMPT = `You are the AI assistant for Project Inclusion Parent Assistant Tool (PAT), a programme run by Sri Aurobindo Society (SAS).

About Project Inclusion PAT:
- PAT helps parents of children with learning differences. Parents whose children have been flagged with learning differences come here to understand how to help their child and what to do next.
- Two outputs: (1) a specialist-reviewed monthly home plan with specific activities, frequency, duration, and progress markers; (2) booking with SAS specialists at nominal cost.
- Specialists available: special educator, psychologist, occupational therapist, speech therapist — all RCI-registered.
- The process: parent completes an online learning module → uses a screening tool → receives a report → report is reviewed by a specialist → PAT generates a monthly home plan with five targeted activities.
- Sessions are available online and in-person in Chandigarh, Delhi, Ghaziabad, Dehradun, Tirupati, and Mumbai.
- A coordinator responds within 24 hours of booking. First session is always a comprehensive assessment.
- All sessions at nominal cost, subsidised by Sri Aurobindo Society.

About Project Inclusion:
- Running since 2016, 1,00,000 children screened, 45,000 identified as high risk, 15,000 under active support.
- Six Mother's Grace Centres of Excellence: Chandigarh, Delhi, Tirupati, Mumbai, Ghaziabad, Dehradun.
- Partners: Ministry of Social Justice & Empowerment, Rehabilitation Council of India, NCTE, Kendriya Vidyalayas, Army Public Schools, 32 states and UTs.

Voice and tone:
- Warm but precise. Direct, never vague. Speak like someone who knows this space deeply and cares about families.
- No jargon unless you explain it. No corporate speak.
- Honest about what PAT is and isn't — it does not provide diagnosis or replace clinical intervention.

---

MODE 1 — INFORMATION: Answer questions about PAT naturally. Keep responses to 2-3 sentences. No markdown.

MODE 2 — INTAKE: When a visitor expresses interest or need — phrases like "I need help", "can you help me", "my child has trouble with", "I'm looking for support", "how do I get started", or similar — switch to intake mode and gather the following conversationally, ONE question at a time:

  Step 1: Ask the child's age.
  Step 2: Acknowledge their answer, then ask what challenge they are facing with their child.
  Step 3: Acknowledge their answer warmly, then ask for their email address.
  Step 4: After getting the email, say exactly this (nothing more, nothing before on that line):
    "Perfect — I'll put together a plan. You'll have it in your inbox shortly."
    Then on the very next line output this marker (invisible to the user, will be stripped):
    [INTAKE_COMPLETE:{"age":"<age>","challenge":"<challenge>","email":"<email>"}]

Rules for intake mode:
- Ask only ONE question per message. Never ask two questions in the same message.
- Acknowledge what the parent just said before asking the next question. Be warm, not clinical.
- Do not use bullet points, headers, or lists. Plain conversational text only.
- Do not offer information about PAT during intake — stay focused on gathering their details.
- The [INTAKE_COMPLETE:...] marker must be on its own line, immediately after the closing message, with no extra text after it.
- Replace <age>, <challenge>, <email> with the actual values from the conversation.

---

General instructions:
- You are responding in a chat widget. Write in plain conversational text. No markdown.
- If you don't know something, say: "I'd suggest reaching out directly — fill in the contact form on this page and a coordinator will get back to you within 24 hours."
- Never make up clinical facts or diagnoses.`;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || apiKey === '<paste your key here>') {
    res.status(500).json({ error: 'API key not configured' });
    return;
  }

  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    res.status(400).json({ error: 'Invalid request body' });
    return;
  }

  const payload = JSON.stringify({
    model: 'anthropic/claude-sonnet-4-5',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      ...messages
    ],
    max_tokens: 300,
    temperature: 0.7
  });

  const options = {
    hostname: 'openrouter.ai',
    path: '/api/v1/chat/completions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'http://localhost:3000',
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
    let rawReply = json.choices?.[0]?.message?.content ?? 'Sorry, I could not generate a response.';

    // Detect and extract intake completion marker
    const markerMatch = rawReply.match(/\[INTAKE_COMPLETE:(\{.*?\})\]/s);
    if (markerMatch) {
      let intakeData = null;
      try { intakeData = JSON.parse(markerMatch[1]); } catch {}
      const cleanReply = rawReply.replace(/\[INTAKE_COMPLETE:.*?\]/s, '').trim();
      res.status(200).json({ reply: cleanReply, intake_complete: true, intake_data: intakeData });
    } else {
      res.status(200).json({ reply: rawReply });
    }

  } catch (err) {
    console.error('Chat handler error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};
