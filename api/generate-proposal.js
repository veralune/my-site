// ============================================================================
// AGENTIC PROPOSAL ENGINE
// ============================================================================
// This serverless function is an AI AGENT — not a script.
// You give Claude tools and a goal. Claude decides what to do.
//
// Flow: Visitor completes intake chat → this function receives the conversation
//       → Claude writes a proposal, renders a PDF, emails it, and alerts you
//       → All autonomously, in 2-3 turns
//
// Tools: 3 core (render PDF, send email, alert owner)
//        + 1 optional (store lead in Supabase — enabled when env vars present)
//
// Works with: Express (local dev via server.js) and Vercel (production)
// ============================================================================

const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const fs = require('fs');
const path = require('path');

// ── Tool definitions for Claude ─────────────────────────────────────────────
// These are the "hands" Claude can use. Claude decides WHEN and HOW to use them.

const CORE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'render_proposal_pdf',
      description: 'Renders a branded proposal PDF. Returns base64-encoded PDF data.',
      parameters: {
        type: 'object',
        properties: {
          company_name: { type: 'string', description: 'The prospect company name' },
          contact_name: { type: 'string', description: 'The prospect contact name' },
          sections: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                heading: { type: 'string' },
                body: { type: 'string' },
              },
              required: ['heading', 'body'],
            },
            description: 'Proposal sections, each with a heading and body text',
          },
        },
        required: ['company_name', 'contact_name', 'sections'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_email',
      description: 'Sends an email to the prospect with optional PDF attachment.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient email address' },
          subject: { type: 'string', description: 'Email subject line' },
          body: { type: 'string', description: 'Email body text (plain text)' },
          attach_pdf: { type: 'boolean', description: 'Whether to attach the proposal PDF' },
        },
        required: ['to', 'subject', 'body'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'alert_owner',
      description: 'Sends a Telegram alert to the owner with lead summary and proposal PDF.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Alert message text including lead score (HIGH/MEDIUM/LOW)' },
        },
        required: ['message'],
      },
    },
  },
];

// Optional tool — only available if Supabase is configured (Power Up: Lead Storage)
const STORE_LEAD_TOOL = {
  type: 'function',
  function: {
    name: 'store_lead',
    description: 'Stores the lead in the CRM database with score and conversation data.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Contact name' },
        company: { type: 'string', description: 'Company name' },
        email: { type: 'string', description: 'Contact email' },
        industry: { type: 'string', description: 'Company industry' },
        challenge: { type: 'string', description: 'Their main challenge (1-2 sentences)' },
        budget: { type: 'string', description: 'Budget range mentioned' },
        score: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'], description: 'Lead score based on triage rules' },
        status: { type: 'string', description: 'Lead status, e.g. proposal_sent' },
      },
      required: ['name', 'company', 'email', 'score', 'status'],
    },
  },
};

// Build tools list — Supabase tool is included only when configured
function getTools() {
  const tools = [...CORE_TOOLS];
  if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
    tools.push(STORE_LEAD_TOOL);
  }
  return tools;
}

// ── PDF text sanitizer ──────────────────────────────────────────────────────
// pdf-lib standard fonts only support WinAnsi encoding (basic ASCII).
// AI-generated text WILL contain characters that crash PDF rendering.
// This function MUST run on ALL text before any drawText() call.

function sanitizeForPdf(text) {
  if (!text) return '';
  return text
    // Currency symbols → text equivalents
    .replace(/₹/g, 'INR ')
    .replace(/€/g, 'EUR ')
    .replace(/£/g, 'GBP ')
    // Dashes → hyphen
    .replace(/[\u2013\u2014\u2015]/g, '-')
    // Curly quotes → straight quotes
    .replace(/[\u2018\u2019\u201A]/g, "'")
    .replace(/[\u201C\u201D\u201E]/g, '"')
    .replace(/[\u2039\u203A]/g, "'")
    .replace(/[\u00AB\u00BB]/g, '"')
    // Ellipsis → three dots
    .replace(/\u2026/g, '...')
    // Special spaces → regular space
    .replace(/[\u00A0\u2002\u2003\u2007\u202F]/g, ' ')
    // Bullets and symbols → ASCII equivalents
    .replace(/[\u2022\u2023\u25E6\u2043]/g, '-')
    .replace(/\u2713/g, '[x]')
    .replace(/\u2717/g, '[ ]')
    .replace(/\u00D7/g, 'x')
    .replace(/\u2192/g, '->')
    .replace(/\u2190/g, '<-')
    .replace(/\u2264/g, '<=')
    .replace(/\u2265/g, '>=')
    // Catch-all: remove anything outside printable ASCII + newlines/tabs
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '');
}

// ── Tool implementations ────────────────────────────────────────────────────

let proposalPdfBase64 = null; // Stored in memory for the email attachment step

async function renderProposalPdf({ company_name, contact_name, sections }) {
  company_name = sanitizeForPdf(company_name);
  contact_name = sanitizeForPdf(contact_name);
  sections = sections.map(s => ({
    heading: sanitizeForPdf(s.heading),
    body: sanitizeForPdf(s.body),
  }));

  const pdf = await PDFDocument.create();
  const font     = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  // PI brand colors
  const deepPurple = rgb(0.141, 0.125, 0.208); // #242035
  const orange     = rgb(0.973, 0.616, 0.208); // #f89d35
  const black      = rgb(0.1,   0.1,   0.1);
  const gray       = rgb(0.45,  0.45,  0.45);
  const lightGray  = rgb(0.96,  0.96,  0.97);
  const white      = rgb(1, 1, 1);

  // Embed PI logo (white background — use on white areas only)
  let piLogo = null;
  try {
    const logoBytes = fs.readFileSync(path.join(__dirname, '..', 'Project Inclusion Logo.png'));
    piLogo = await pdf.embedPng(logoBytes);
  } catch (e) {
    console.log('Logo not embedded:', e.message);
  }

  // ── Helper: draw logo in top-right corner of a white page ──
  function drawLogoCorner(p) {
    if (!piLogo) return;
    const dims = piLogo.scaleToFit(100, 36);
    p.drawImage(piLogo, {
      x: 612 - dims.width - 36,
      y: 792 - dims.height - 14,
      width: dims.width,
      height: dims.height,
    });
  }

  // ── COVER PAGE ──
  const cover = pdf.addPage([612, 792]);

  // Deep purple top band (top 160px)
  cover.drawRectangle({ x: 0, y: 632, width: 612, height: 160, color: deepPurple });
  // Orange bottom strip of band
  cover.drawRectangle({ x: 0, y: 628, width: 612, height: 4, color: orange });

  // Text in purple band (white area of band is fine — but logo has white bg so put below)
  cover.drawText('PROJECT INCLUSION', {
    x: 40, y: 758, size: 15, font: fontBold, color: white,
  });
  cover.drawText('Parent Assistant Tool', {
    x: 40, y: 738, size: 10, font, color: rgb(0.75, 0.75, 0.75),
  });
  cover.drawText('Sri Aurobindo Society  |  Since 2016', {
    x: 40, y: 648, size: 9, font, color: rgb(0.65, 0.65, 0.65),
  });

  // Logo placed on white area below the band (top-right corner)
  if (piLogo) {
    const dims = piLogo.scaleToFit(110, 40);
    cover.drawImage(piLogo, {
      x: 612 - dims.width - 36,
      y: 632 - dims.height - 10,
      width: dims.width,
      height: dims.height,
    });
  }

  // Cover title block
  cover.drawText("YOUR CHILD'S", {
    x: 40, y: 560, size: 12, font: fontBold, color: orange,
  });
  cover.drawText('Home Support Plan', {
    x: 40, y: 530, size: 32, font: fontBold, color: deepPurple,
  });
  // Orange rule under title
  cover.drawRectangle({ x: 40, y: 520, width: 56, height: 3, color: orange });

  cover.drawText('Prepared for: ' + contact_name, {
    x: 40, y: 494, size: 12, font, color: black,
  });
  cover.drawText(
    new Date().toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' }),
    { x: 40, y: 474, size: 10, font, color: gray }
  );

  // Credibility box
  cover.drawRectangle({ x: 40, y: 350, width: 532, height: 88, color: lightGray });
  cover.drawRectangle({ x: 40, y: 350, width: 4,   height: 88, color: orange });
  cover.drawText('Project Inclusion  |  Sri Aurobindo Society', {
    x: 56, y: 416, size: 11, font: fontBold, color: deepPurple,
  });
  cover.drawText('Running since 2016  |  32 states  |  1,00,000+ children screened', {
    x: 56, y: 396, size: 9, font, color: gray,
  });
  cover.drawText('6 Centres of Excellence  |  All specialists RCI-registered', {
    x: 56, y: 379, size: 9, font, color: gray,
  });
  cover.drawText('Sessions at nominal cost, subsidised by Sri Aurobindo Society', {
    x: 56, y: 362, size: 9, font, color: gray,
  });

  // Cover footer
  cover.drawRectangle({ x: 0, y: 0, width: 612, height: 44, color: deepPurple });
  cover.drawText('projectinclusion.in  |  aashnaaik@gmail.com', {
    x: 40, y: 17, size: 9, font, color: rgb(0.65, 0.65, 0.65),
  });

  // ── CONTENT PAGES ──
  // Header: thin deep purple bar (28px) + orange strip (3px) — purely decorative, no logo overlap
  // Footer: thin deep purple bar (28px)
  // Logo: top-right white corner
  // Content: y from 740 down to 50

  function newContentPage() {
    const p = pdf.addPage([612, 792]);
    // Header bar
    p.drawRectangle({ x: 0, y: 764, width: 612, height: 28, color: deepPurple });
    p.drawRectangle({ x: 0, y: 761, width: 612, height: 3,  color: orange });
    p.drawText('PROJECT INCLUSION  |  Parent Assistant Tool', {
      x: 40, y: 773, size: 8, font, color: rgb(0.65, 0.65, 0.65),
    });
    // Footer bar
    p.drawRectangle({ x: 0, y: 0, width: 612, height: 28, color: deepPurple });
    p.drawText('projectinclusion.in', {
      x: 40, y: 10, size: 8, font, color: rgb(0.6, 0.6, 0.6),
    });
    // Logo top-right on white
    drawLogoCorner(p);
    return p;
  }

  let page = newContentPage();
  // Start below header (764) with padding, and above logo (logo top ~792-14-36=742)
  // Safe content area: y from 735 down to 40
  let y = 728;
  const maxWidth = 512;
  const BOTTOM_MARGIN = 42;

  function drawLine(text, options) {
    if (y < BOTTOM_MARGIN) {
      page = newContentPage();
      y = 728;
    }
    page.drawText(text, { x: 40, y, ...options });
    y -= (options.lineHeight || (options.size || 11) + 6);
  }

  for (const section of sections) {
    if (y < BOTTOM_MARGIN + 80) {
      page = newContentPage();
      y = 728;
    }

    // Section heading: light gray bg box, orange left rule, bold text inside
    const headingH = 24;
    page.drawRectangle({ x: 40, y: y - 4, width: 532, height: headingH, color: lightGray });
    page.drawRectangle({ x: 40, y: y - 4, width: 4,   height: headingH, color: orange });
    page.drawText(section.heading, {
      x: 50, y: y + 4, size: 12, font: fontBold, color: deepPurple,
    });
    y -= (headingH + 10);

    // Section body
    const paragraphs = section.body.split('\n');
    for (const paragraph of paragraphs) {
      if (paragraph.trim() === '') { y -= 6; continue; }
      const words = paragraph.split(' ');
      let line = '';
      for (const word of words) {
        const testLine = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(testLine, 11) > maxWidth && line) {
          drawLine(line, { size: 11, font, color: black });
          line = word;
        } else {
          line = testLine;
        }
      }
      if (line) drawLine(line, { size: 11, font, color: black });
    }
    y -= 18; // gap between sections
  }

  const pdfBytes = await pdf.save();
  proposalPdfBase64 = Buffer.from(pdfBytes).toString('base64');
  return { success: true, pages: pdf.getPageCount(), size_kb: Math.round(pdfBytes.length / 1024) };
}

async function sendEmail({ to, subject, body, attach_pdf }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { success: false, error: 'RESEND_API_KEY not configured' };

  // Resend free tier only allows sending to the verified address.
  // Route all emails to the owner; include the parent's original address in the body.
  const verifiedOwner = 'aashnaaik@gmail.com';
  const actualRecipient = (to !== verifiedOwner) ? verifiedOwner : to;
  const bodyWithRecipient = (to !== verifiedOwner)
    ? `[Forward to parent: ${to}]\n\n${body}`
    : body;

  const payload = {
    from: 'Project Inclusion PAT <onboarding@resend.dev>',
    to: actualRecipient,
    subject,
    text: bodyWithRecipient,
  };

  if (attach_pdf && proposalPdfBase64) {
    payload.attachments = [{
      filename: 'proposal.pdf',
      content: proposalPdfBase64,
    }];
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('Resend error:', err);
    return { success: false, error: `Resend API error: ${res.status}` };
  }

  const data = await res.json();
  return { success: true, email_id: data.id };
}

async function storeLead(leadData) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) return { success: false, error: 'Supabase not configured' };

  // Fields match the leads table schema:
  // name, company, email, industry, challenge, budget, score, status
  // conversation_transcript and created_at are handled separately
  const row = {
    name: leadData.name || null,
    company: leadData.company || null,
    email: leadData.email || null,
    industry: leadData.industry || null,
    challenge: leadData.challenge || null,
    budget: leadData.budget || null,
    score: leadData.score || null,
    status: leadData.status || 'proposal_sent',
  };

  const res = await fetch(`${url}/rest/v1/leads`, {
    method: 'POST',
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(row),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('Supabase error:', err);
    return { success: false, error: `Supabase error: ${res.status}` };
  }

  return { success: true };
}

async function alertOwner({ message }) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_USER_ID;
  if (!botToken || !chatId) return { success: false, error: 'Telegram not configured' };

  // Send text alert
  const textRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: message }),
  });

  if (!textRes.ok) {
    const err = await textRes.text();
    console.error('Telegram error:', err);
    return { success: false, error: `Telegram error: ${textRes.status}` };
  }

  // Send proposal PDF if available
  if (proposalPdfBase64) {
    const pdfBuffer = Buffer.from(proposalPdfBase64, 'base64');
    const formData = new FormData();
    formData.append('chat_id', chatId);
    formData.append('document', new Blob([pdfBuffer], { type: 'application/pdf' }), 'proposal.pdf');
    formData.append('caption', 'Proposal PDF attached');

    await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
      method: 'POST',
      body: formData,
    });
  }

  return { success: true };
}

// ── Tool dispatcher ─────────────────────────────────────────────────────────

async function executeTool(name, args) {
  switch (name) {
    case 'render_proposal_pdf': return renderProposalPdf(args);
    case 'send_email':          return sendEmail(args);
    case 'store_lead':          return storeLead(args);
    case 'alert_owner':         return alertOwner(args);
    default:                    return { error: `Unknown tool: ${name}` };
  }
}

// ── Agent system prompt ─────────────────────────────────────────────────────
// [CUSTOMIZE] Claude will replace everything below with YOUR identity, voice,
// services, and triage rules from your CLAUDE.md.

const AGENT_SYSTEM_PROMPT = `You are an AI agent acting on behalf of Project Inclusion Parent Assistant Tool (PAT), run by Sri Aurobindo Society (SAS).

You have received intake data from a parent who needs support for their child. Your job:
1. Write a warm, personalised home plan summary in PAT's voice
2. Score the lead (HIGH/MEDIUM/LOW) using the triage rules below
3. Use your tools to: render the summary as a PDF, email it to the parent, and alert the PAT coordinator on Telegram

## IDENTITY & VOICE
Project Inclusion has been running since 2016 across 32 states, 14 lakh students. PAT brings this directly to families. Voice: warm but precise. Direct, never vague. Speak like someone who knows this space deeply and cares about families. No jargon. No corporate speak. Honest about what PAT is and is not - it does not provide diagnosis or replace clinical intervention.

## WHAT WE OFFER
1. Learning Resources (Free) - Access to the Project Inclusion LMS: self-paced guide on learning differences in plain language.
2. Screening Tool (Free) - Structured observation-based screening that generates a report identifying areas of concern.
3. PAT Home Plan Bot (Free) - AI-generated monthly home plan: 5 targeted activities, 10-20 minutes each, 3-5 times a week, household materials only. Instantly delivered.
4. Specialist Booking (Paid) - RCI-registered specialists: special educator, psychologist, occupational therapist, speech therapist. Rs. 700 per session on average, Rs. 22,000 per month for ongoing engagement. In-person in Chandigarh, Delhi, Ghaziabad, Dehradun, Tirupati, Mumbai. All other locations online.

## LEAD TRIAGE RULES
HIGH - Paying parent, warm lead: Tier 1/2 city, child aged 4-12, specific challenge described, formally flagged by school or teacher, valid email, actively seeking next steps.
MEDIUM - Either: Tier 1/2 city but child aged 13-16 / child not formally flagged but specific concern / outside the 6 cities but willing to do online / cannot pay but highly engaged with free tools / general but motivated description.
LOW - Exploratory, no specific concern, child age outside 4-16, concern is purely academic performance (tutoring mismatch), existing SAS case, or invalid email.

## PROPOSAL STRUCTURE
Write 3-4 sections personalised to the parent's intake:
1. What We Heard - acknowledge their specific situation and child's challenge warmly
2. Where to Start - recommend the right first step (free tools or specialist booking based on their profile)
3. Your Child's Home Plan - brief sample of what a monthly plan looks like for their child's challenge area
4. Next Steps - what happens when they click through: coordinator calls within 24 hours, first session is always a comprehensive assessment

## INSTRUCTIONS
- Use the parent's name and child's age/challenge throughout - make it feel personal
- Score the lead and include the score in the alert_owner call
- render_proposal_pdf: use "Project Inclusion PAT" as company_name and parent's name as contact_name
- send_email: warm, short covering email, attach the PDF, subject line references the child's challenge
- alert_owner: include parent name, email, child age, challenge, city if known, lead score, and one sentence on why
- Write in plain text - no markdown in the PDF sections
- Do not mention diagnosis, do not make clinical claims
- You decide the tool order. render_proposal_pdf must complete before send_email if attaching PDF.`;

// ── Main handler ────────────────────────────────────────────────────────────
// Works as both Express route (local dev) and Vercel serverless function

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Accept both naming conventions from frontend
  const conversation = req.body.conversation || req.body.messages;
  const intakeData = req.body.intakeData || req.body.intake_data;
  console.log('generate-proposal received intakeData:', JSON.stringify(intakeData));
  console.log('generate-proposal conversation length:', conversation?.length);
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'OPENROUTER_API_KEY not configured' });

  if (!conversation && !intakeData) {
    return res.status(400).json({ error: 'conversation or intakeData required' });
  }

  // Reset PDF state for this request
  proposalPdfBase64 = null;

  // Build context from intake data or conversation transcript
  const intakeContext = intakeData
    ? `VISITOR INTAKE DATA:\n${JSON.stringify(intakeData, null, 2)}`
    : `CONVERSATION TRANSCRIPT:\n${conversation.map(m => `${m.role}: ${m.content}`).join('\n')}`;

  // Build tools list — store_lead only available if Supabase is configured
  const tools = getTools();
  const supabaseEnabled = tools.some(t => t.function?.name === 'store_lead');
  console.log(`Agent starting with ${tools.length} tools${supabaseEnabled ? ' (Supabase enabled)' : ''}`);

  let messages = [
    { role: 'system', content: AGENT_SYSTEM_PROMPT },
    { role: 'user', content: `${intakeContext}\n\nPlease write a personalized proposal, score this lead, and use your tools to send everything.` },
  ];

  const results = { proposal: false, email: false, stored: false, alerted: false };

  // ── Agent loop — max 5 turns for safety ──
  for (let turn = 1; turn <= 5; turn++) {
    console.log(`Agent turn ${turn}...`);

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': req.headers?.host ? `https://${req.headers.host}` : 'http://localhost:3000',
      },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4.6',
        messages,
        tools,
        max_tokens: 4096,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Agent OpenRouter error:', err);
      return res.status(502).json({ error: 'Agent API call failed', details: err });
    }

    const data = await response.json();
    const choice = data.choices?.[0];
    if (!choice) {
      console.error('Agent: no choice in response');
      break;
    }

    const assistantMessage = choice.message;
    messages.push(assistantMessage);

    // No tool calls = agent is done thinking
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      console.log(`Agent turn ${turn}... Agent completed.`);
      break;
    }

    // Execute each tool call
    const toolNames = assistantMessage.tool_calls.map(tc => tc.function.name);
    console.log(`Agent turn ${turn}... Claude called ${assistantMessage.tool_calls.length} tool(s): ${toolNames.join(', ')}`);

    for (const toolCall of assistantMessage.tool_calls) {
      let args;
      try {
        args = JSON.parse(toolCall.function.arguments);
      } catch (e) {
        console.error(`Failed to parse tool args for ${toolCall.function.name}:`, e.message);
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify({ error: 'Failed to parse arguments' }),
        });
        continue;
      }

      const result = await executeTool(toolCall.function.name, args);

      // Track what succeeded
      if (toolCall.function.name === 'render_proposal_pdf' && result.success) results.proposal = true;
      if (toolCall.function.name === 'send_email' && result.success) results.email = true;
      if (toolCall.function.name === 'store_lead' && result.success) results.stored = true;
      if (toolCall.function.name === 'alert_owner' && result.success) results.alerted = true;

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      });
    }
  }

  console.log('Agent pipeline complete:', results);
  return res.json({ success: true, results });
};
