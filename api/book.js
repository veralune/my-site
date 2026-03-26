const https = require('https');

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://project-inclusion.vercel.app';

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const origin = req.headers['origin'] || req.headers['referer'] || '';
  if (ALLOWED_ORIGIN && !origin.includes(ALLOWED_ORIGIN.replace('https://', ''))) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  const apiKey = process.env.RESEND_API_KEY;
  const toEmail = process.env.BOOKING_EMAIL;
  if (!apiKey || !toEmail) {
    res.status(500).json({ error: 'Booking not configured' });
    return;
  }

  const { specialist, profile } = req.body || {};
  if (!specialist) {
    res.status(400).json({ error: 'Missing specialist' });
    return;
  }

  const body = `New specialist booking request from PAT Web

Specialist requested: ${specialist}

Child details:
- Name: ${profile?.child_name || 'N/A'}
- Age: ${profile?.child_age || 'N/A'}
- Challenge: ${profile?.child_challenge || 'N/A'}
- Language: ${profile?.language || 'English'}

Parent email: ${profile?.child_email || 'Not provided'}

Please contact the parent within 24 hours to confirm their appointment.`;

  const payload = JSON.stringify({
    from: 'PAT Bot <onboarding@resend.dev>',
    to: [toEmail],
    subject: `New Booking Request — ${specialist}`,
    text: body
  });

  const options = {
    hostname: 'api.resend.com',
    path: '/emails',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'Content-Length': Buffer.byteLength(payload)
    }
  };

  try {
    await new Promise((resolve, reject) => {
      const apiReq = https.request(options, (apiRes) => {
        let data = '';
        apiRes.on('data', chunk => { data += chunk; });
        apiRes.on('end', () => resolve(data));
      });
      apiReq.on('error', reject);
      apiReq.write(payload);
      apiReq.end();
    });
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Booking email error:', err);
    res.status(500).json({ error: 'Failed to send booking email' });
  }
};
