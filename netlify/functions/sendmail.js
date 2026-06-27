const nodemailer = require('nodemailer');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  try {
    const { to, subject, body, smtpPass } = JSON.parse(event.body);

    if (!to || !subject || !body || !smtpPass) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing fields' }) };
    }

    const transporter = nodemailer.createTransport({
      host: 'smtp.svethostingu.cz',
      port: 465,
      secure: true,
      auth: {
        user: 'grupos@tour-pragenses.com',
        pass: smtpPass,
      },
    });

    await transporter.sendMail({
      from: '"Helena Dlasková | Tour Pragenses" <grupos@tour-pragenses.com>',
      to,
      subject,
      text: body,
    });

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
