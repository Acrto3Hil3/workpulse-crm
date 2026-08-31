'use strict';
// Automated WhatsApp sending via the official Meta WhatsApp Cloud API.
// Turns on when BOTH are set in .env:
//   WHATSAPP_TOKEN     — permanent access token from developers.facebook.com
//   WHATSAPP_PHONE_ID  — the "Phone number ID" of your WhatsApp business number
// Special value WHATSAPP_TOKEN=json sends nothing and prints messages to the log (testing).
//
// Note on Meta's rules: free-form text messages only reach people who messaged your
// business number in the last 24 hours. For daily reminders that always deliver,
// create an approved message template and set WHATSAPP_TEMPLATE (the text is then
// sent as the template's {{1}} parameter). See README → "WhatsApp setup".

const API_VERSION = process.env.WHATSAPP_API_VERSION || 'v21.0';

function isEnabled() {
  return Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID);
}

function isTestMode() {
  return process.env.WHATSAPP_TOKEN === 'json';
}

/** '98000 00001' -> '919800000001' (10-digit numbers get the country code). */
function normalizeNumber(raw) {
  if (!raw) return null;
  let p = String(raw).replace(/\D/g, '');
  if (!p) return null;
  if (p.length === 10) p = (process.env.WHATSAPP_CC || '91') + p;
  return p.length >= 11 && p.length <= 15 ? p : null;
}

async function sendWhatsApp(to, text) {
  if (!isEnabled()) return false;
  const num = normalizeNumber(to);
  if (!num || !text) return false;

  if (isTestMode()) {
    console.log(`[whatsapp:test-mode] -> ${num}: ${String(text).split('\n')[0].slice(0, 120)}`);
    return true;
  }

  const url = `https://graph.facebook.com/${API_VERSION}/${process.env.WHATSAPP_PHONE_ID}/messages`;
  const template = process.env.WHATSAPP_TEMPLATE;
  const payload = template
    ? {
        messaging_product: 'whatsapp',
        to: num,
        type: 'template',
        template: {
          name: template,
          language: { code: process.env.WHATSAPP_TEMPLATE_LANG || 'en' },
          components: [{
            type: 'body',
            // Template parameters cannot contain newlines — flatten the message.
            parameters: [{ type: 'text', text: String(text).replace(/\s*\n+\s*/g, ' | ').slice(0, 900) }]
          }]
        }
      }
    : {
        messaging_product: 'whatsapp',
        to: num,
        type: 'text',
        text: { body: String(text).slice(0, 3900) }
      };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const body = await res.text();
      console.error('[whatsapp] send failed', res.status, body.slice(0, 300));
      return false;
    }
    return true;
  } catch (err) {
    console.error('[whatsapp] send error', err.message);
    return false;
  }
}

module.exports = { isEnabled, isTestMode, normalizeNumber, sendWhatsApp };
