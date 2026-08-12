'use strict';
// HTML email templates for Crumb & Ember.
//
// Design notes, because email is not the web:
//
// * Tables and inline styles only. No flexbox, no grid, no <style> block —
//   Gmail strips embedded CSS in several contexts and Outlook never had it.
// * NO IMAGES ANYWHERE. The banner is built from type and colour blocks, so
//   it renders instantly and identically whether or not the client blocks
//   remote images — which Gmail does by default for unknown senders. An
//   image-based banner would show as a grey box on exactly the first email a
//   new customer receives, which is the one that matters most.
// * Colours are the site's own tokens (services/frontend/index.html), so the
//   mail and the shop look like the same business.
// * Dark mode: the palette leads with saturated pink and chocolate rather
//   than white. Gmail's dark theme rewrites near-white backgrounds and leaves
//   saturated ones alone, so the banner survives the treatment the recipient
//   in the screenshot is actually using.
// * Every template returns plain text too. A text/plain alternative is what
//   keeps the message out of spam filters and readable in a watch preview.

// Site palette — services/frontend/index.html :root
const C = {
  pink:   '#FFE3EF',  // strawberry milk — page base
  milk:   '#FFF6EE',  // card cream
  choc:   '#33200F',  // ink — dark chocolate
  straw:  '#FF4D8D',  // strawberry
  butter: '#FFB428',  // butter / yolk
  pist:   '#2FBF71',  // pistachio
  cocoa:  '#6B4A2F',  // muted ink for secondary text
  crust:  '#E7C9A9'   // hairline / rule
};

// Nunito, Space Mono and Titan One are the site faces; none of them can be
// relied on in mail, so each stack degrades to something with the same
// personality — rounded grotesque, then monospace for anything numeric.
const F_BODY = "'Nunito','Trebuchet MS',Verdana,Helvetica,Arial,sans-serif";
const F_MONO = "'Space Mono','Courier New',Courier,monospace";

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Negatives get the sign in front of the symbol (-₹320.00, not ₹-320.00),
// which is how a discount line should read.
const money = (n, currency = '₹') => {
  const v = Number(n || 0);
  const body = Math.abs(v).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${v < 0 ? '-' : ''}${currency}${body}`;
};

// --- shared chrome ---------------------------------------------------------

// Hidden preheader: the grey line the inbox shows next to the subject. Left
// unset it fills with whatever text comes first, which is usually the banner
// wordmark repeated — a wasted second line in the inbox list.
const preheader = (text) => `
      <div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${esc(text)}</div>
      <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>`;

// The banner. Chocolate band, butter rule, letterspaced wordmark, and a
// coloured eyebrow strip whose colour is the one thing that changes between
// message types — so the mail is identifiable before a word is read.
const banner = (accent, eyebrow) => `
        <tr>
          <td style="background-color:${C.choc};padding:28px 32px 22px 32px;border-radius:18px 18px 0 0;">
            <div style="font-family:${F_BODY};font-size:26px;font-weight:800;color:${C.milk};letter-spacing:3px;line-height:1.1;">
              CRUMB<span style="color:${C.butter};">&nbsp;&amp;&nbsp;</span>EMBER
            </div>
            <div style="font-family:${F_MONO};font-size:11px;color:${C.crust};letter-spacing:2.5px;padding-top:6px;">
              SMALL&nbsp;BATCH&nbsp;BAKERY
            </div>
          </td>
        </tr>
        <tr><td style="background-color:${accent};height:8px;line-height:8px;font-size:0;">&nbsp;</td></tr>
        <tr>
          <td style="background-color:${C.milk};padding:26px 32px 0 32px;">
            <div style="font-family:${F_MONO};font-size:11px;font-weight:700;color:${accent};letter-spacing:2.5px;text-transform:uppercase;">
              ${esc(eyebrow)}
            </div>
          </td>
        </tr>`;

const footer = () => `
        <tr>
          <td style="background-color:${C.milk};padding:26px 32px 30px 32px;border-radius:0 0 18px 18px;border-top:1px solid ${C.crust};">
            <div style="font-family:${F_BODY};font-size:13px;color:${C.cocoa};line-height:1.6;">
              Crumb &amp; Ember · baked this morning, gone by four
            </div>
            <div style="font-family:${F_BODY};font-size:12px;color:${C.cocoa};line-height:1.6;padding-top:6px;">
              This is an automated message — replies aren't monitored.
            </div>
          </td>
        </tr>`;

// Marketing footer. Promotional mail carries obligations transactional mail
// does not — an unsubscribe path, a postal address, and a plain statement of
// why this landed in the inbox (CAN-SPAM / GDPR / PECR all want some mix of
// these). Kept separate from footer() so a transactional receipt never grows
// an unsubscribe link, which would let someone opt out of their own order
// confirmations.
const marketingFooter = (data = {}) => {
  const unsubscribeUrl = linkTo(data, data.unsubscribeUrl, 'unsubscribe');
  const prefsUrl = linkTo(data, data.preferencesUrl, 'email-preferences');
  const address = data.senderAddress || 'Crumb & Ember, 14 Mill Lane, Bengaluru 560001, India';
  const reason = data.reasonLine || 'You are receiving this because you opted in to offers from Crumb & Ember.';
  return `
        <tr>
          <td style="background-color:${C.milk};padding:26px 32px 30px 32px;border-radius:0 0 18px 18px;border-top:1px solid ${C.crust};">
            <div style="font-family:${F_BODY};font-size:13px;color:${C.cocoa};line-height:1.6;">
              Crumb &amp; Ember · baked this morning, gone by four
            </div>
            <div style="font-family:${F_BODY};font-size:12px;color:${C.cocoa};line-height:1.6;padding-top:8px;">
              ${esc(reason)}
            </div>
            <div style="font-family:${F_BODY};font-size:12px;color:${C.cocoa};line-height:1.6;padding-top:8px;">
              <a href="${esc(href(unsubscribeUrl))}" style="color:${C.cocoa};text-decoration:underline;">Unsubscribe</a>${prefsUrl ? ` &nbsp;·&nbsp; <a href="${esc(href(prefsUrl))}" style="color:${C.cocoa};text-decoration:underline;">Email preferences</a>` : ''}
            </div>
            <div style="font-family:${F_BODY};font-size:11px;color:${C.cocoa};line-height:1.6;padding-top:8px;">
              ${esc(address)}
            </div>
          </td>
        </tr>`;
};

const shell = (title, accent, inner, pre) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>${esc(title)}</title>
</head>
<body style="margin:0;padding:0;background-color:${C.pink};">
${preheader(pre)}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${C.pink};">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">
${banner(accent, inner.eyebrow)}
${inner.body}
${inner.footer || footer()}
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

// --- verification code -----------------------------------------------------
// Signature element: the code as separate digit tiles, the way a bakery
// counter ticket prints them. It also solves a real problem — a six-digit run
// of identical-width mono glyphs is easy to misread and hard to select on a
// phone, and the tiles force a pause between characters.
function verificationCode(data = {}) {
  const code = String(data.code || '');
  const minutes = Number(data.expiresMinutes || 10);
  const purpose = data.purpose || 'verification';
  const name = data.customerName ? `${esc(data.customerName)}, this` : 'This';

  const tiles = code.split('').map((ch) => `
                    <td style="padding:0 4px;">
                      <div style="background-color:${C.choc};border-radius:10px;width:46px;height:58px;line-height:58px;text-align:center;font-family:${F_MONO};font-size:26px;font-weight:700;color:${C.butter};">${esc(ch)}</div>
                    </td>`).join('');

  const body = `
        <tr>
          <td style="background-color:${C.milk};padding:10px 32px 0 32px;">
            <h1 style="margin:0;font-family:${F_BODY};font-size:27px;line-height:1.25;font-weight:800;color:${C.choc};">
              Here's your code
            </h1>
            <p style="margin:10px 0 0 0;font-family:${F_BODY};font-size:15px;line-height:1.6;color:${C.cocoa};">
              ${name} confirms your ${esc(purpose)}. It works once, and only for the next ${esc(minutes)} minutes.
            </p>
          </td>
        </tr>
        <tr>
          <td style="background-color:${C.milk};padding:24px 32px 4px 32px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center">
              <tr>
                <td>
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${tiles}</tr></table>
                </td>
              </tr>
            </table>
            <div style="text-align:center;padding-top:14px;font-family:${F_MONO};font-size:12px;color:${C.cocoa};letter-spacing:1px;">
              EXPIRES IN ${esc(minutes)} MINUTES
            </div>
          </td>
        </tr>
        <tr>
          <td style="background-color:${C.milk};padding:22px 32px 28px 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="background-color:${C.pink};border-left:4px solid ${C.straw};border-radius:0 10px 10px 0;padding:14px 16px;">
                  <div style="font-family:${F_BODY};font-size:14px;line-height:1.6;color:${C.choc};">
                    Didn't ask for this? Ignore the email — nothing changes without the code. Nobody from Crumb &amp; Ember will ever ask you for it.
                  </div>
                </td>
              </tr>
            </table>
          </td>
        </tr>`;

  const text = [
    `Your Crumb & Ember code is ${code}.`,
    `It confirms your ${purpose} and expires in ${minutes} minutes.`,
    '',
    "Didn't ask for this? Ignore this email — nothing changes without the code.",
    'Nobody from Crumb & Ember will ever ask you for it.'
  ].join('\n');

  return {
    subject: 'Your Crumb & Ember verification code',
    html: shell('Your Crumb & Ember verification code', C.straw,
      { eyebrow: 'Verification code', body }, `${code} — expires in ${minutes} minutes`),
    text
  };
}

// --- order confirmation ----------------------------------------------------
// Signature element: a docket-style itemised list with dotted leaders, set the
// way the counter prints it. The status strip is three fixed stages because
// that is genuinely what happens to an order here — it is a real sequence, not
// decorative numbering.
function orderConfirmation(data = {}) {
  const orderId = data.orderId || '—';
  const currency = data.currency || '₹';
  const items = Array.isArray(data.items) ? data.items : [];
  const greeting = data.customerName ? `Thanks, ${esc(data.customerName)}` : 'Thanks for your order';
  const when = data.readyAt || data.eta || '';
  const pickup = data.fulfilment === 'pickup';
  const where = data.address || (pickup ? 'Collection at the counter' : '');
  const whereLabel = pickup ? 'PICKING UP' : 'GOING TO';
  const orderUrl = linkTo(data, data.orderUrl, orderId !== '—' ? `orders/${encodeURIComponent(orderId)}` : 'orders');

  const rows = items.map((it) => `
              <tr>
                <td style="padding:9px 0;border-bottom:1px dotted ${C.crust};font-family:${F_BODY};font-size:15px;color:${C.choc};">
                  ${esc(it.name)}
                  ${Number(it.qty) > 1 ? `<div style="font-family:${F_MONO};font-size:12px;color:${C.cocoa};padding-top:2px;">${esc(it.qty)} &times; ${esc(money(Number(it.price || 0) / Number(it.qty), currency))}</div>` : ''}
                </td>
                <td align="right" style="padding:9px 0;border-bottom:1px dotted ${C.crust};font-family:${F_MONO};font-size:14px;color:${C.choc};white-space:nowrap;">
                  ${esc(money(it.price, currency))}
                </td>
              </tr>`).join('');

  const totalRow = (label, value, strong) => `
              <tr>
                <td style="padding:${strong ? '12px 0 0 0' : '7px 0 0 0'};font-family:${F_BODY};font-size:${strong ? '16px' : '14px'};font-weight:${strong ? '800' : '400'};color:${strong ? C.choc : C.cocoa};">${esc(label)}</td>
                <td align="right" style="padding:${strong ? '12px 0 0 0' : '7px 0 0 0'};font-family:${F_MONO};font-size:${strong ? '18px' : '14px'};font-weight:${strong ? '700' : '400'};color:${strong ? C.choc : C.cocoa};white-space:nowrap;">${esc(money(value, currency))}</td>
              </tr>`;

  const stage = (label, active) => `
                <td width="33%" align="center" style="padding:0 3px;">
                  <div style="background-color:${active ? C.pist : C.crust};height:5px;line-height:5px;font-size:0;border-radius:3px;">&nbsp;</div>
                  <div style="font-family:${F_MONO};font-size:10px;letter-spacing:1px;color:${active ? C.choc : C.cocoa};padding-top:7px;">${esc(label)}</div>
                </td>`;

  const body = `
        <tr>
          <td style="background-color:${C.milk};padding:10px 32px 0 32px;">
            <h1 style="margin:0;font-family:${F_BODY};font-size:27px;line-height:1.25;font-weight:800;color:${C.choc};">
              ${greeting} — it's in the oven
            </h1>
            <p style="margin:10px 0 0 0;font-family:${F_BODY};font-size:15px;line-height:1.6;color:${C.cocoa};">
              Order <span style="font-family:${F_MONO};color:${C.choc};font-weight:700;">${esc(orderId)}</span>${when ? ` · ready ${esc(when)}` : ''}
            </p>
          </td>
        </tr>
        <tr>
          <td style="background-color:${C.milk};padding:22px 32px 6px 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>${stage('BAKING', true)}${stage('BOXED', false)}${stage('READY', false)}</tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="background-color:${C.milk};padding:18px 32px 0 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              ${rows}
              ${data.subtotal != null ? totalRow('Subtotal', data.subtotal) : ''}
              ${data.delivery != null ? totalRow('Delivery', data.delivery) : ''}
              ${data.discount ? totalRow('Discount', -Math.abs(data.discount)) : ''}
              ${totalRow('Total', data.total, true)}
            </table>
          </td>
        </tr>
        ${where ? `
        <tr>
          <td style="background-color:${C.milk};padding:22px 32px 0 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="background-color:${C.pink};border-left:4px solid ${C.pist};border-radius:0 10px 10px 0;padding:14px 16px;">
                  <div style="font-family:${F_MONO};font-size:10px;letter-spacing:2px;color:${C.cocoa};">${esc(whereLabel)}</div>
                  <div style="font-family:${F_BODY};font-size:15px;line-height:1.6;color:${C.choc};padding-top:3px;">${esc(where)}</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>` : ''}
        <tr>
          <td style="background-color:${C.milk};padding:24px 32px 30px 32px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="background-color:${C.straw};border-radius:12px;">
                  <a href="${esc(href(orderUrl))}" style="display:inline-block;padding:14px 28px;font-family:${F_BODY};font-size:15px;font-weight:800;color:${C.milk};text-decoration:none;letter-spacing:0.3px;">
                    Track this order
                  </a>
                </td>
              </tr>
            </table>
          </td>
        </tr>`;

  const text = [
    `${data.customerName ? `Thanks, ${data.customerName}` : 'Thanks for your order'} — it's in the oven.`,
    `Order ${orderId}${when ? ` · ready ${when}` : ''}`,
    '',
    ...items.map((it) => Number(it.qty) > 1
      ? `  ${it.name}  (${it.qty} x ${money(Number(it.price || 0) / Number(it.qty), currency)})  ${money(it.price, currency)}`
      : `  ${it.name}  ${money(it.price, currency)}`),
    '',
    data.subtotal != null ? `Subtotal ${money(data.subtotal, currency)}` : '',
    data.delivery != null ? `Delivery ${money(data.delivery, currency)}` : '',
    `Total ${money(data.total, currency)}`,
    where ? `\n${pickup ? 'Picking up' : 'Going to'}: ${where}` : '',
    orderUrl ? `\nTrack this order: ${orderUrl}` : ''
  ].filter(Boolean).join('\n');

  return {
    subject: `Order ${orderId} is in the oven`,
    html: shell(`Order ${orderId}`, C.pist, { eyebrow: 'Order confirmed', body },
      `${items.length} item${items.length === 1 ? '' : 's'} · ${money(data.total, currency)}${when ? ` · ready ${when}` : ''}`),
    text
  };
}

// --- links -----------------------------------------------------------------
// CTA destinations are built from APP_BASE_URL so no hostname is hardcoded in
// a template (or in this repository). Callers may still pass a full absolute
// URL to override — useful for campaign tracking links on a different domain.
//
// Resolution order for any CTA:
//   1. an absolute URL the caller passed          -> used as-is
//   2. a path the caller passed ('/menu')         -> joined onto the base
//   3. the template's own default path            -> joined onto the base
//   4. no base configured                         -> '#', and the plain-text
//      part omits the line rather than printing a dead link
const APP_BASE_URL = (process.env.APP_BASE_URL || '').replace(/\/+$/, '');

const isAbsolute = (u) => /^https?:\/\//i.test(String(u || ''));

// `data.baseUrl` lets a caller (or a test) override the env for one send.
const linkTo = (data, explicit, defaultPath) => {
  if (isAbsolute(explicit)) return explicit;
  const base = (data.baseUrl || APP_BASE_URL || '').replace(/\/+$/, '');
  const path = explicit || defaultPath || '';
  if (!base) return isAbsolute(path) ? path : '';
  if (!path) return base;
  return `${base}/${String(path).replace(/^\/+/, '')}`;
};

// An empty string means "no destination configured"; buttons fall back to '#'
// so the markup stays valid, but the text part drops the line entirely.
const href = (u) => u || '#';


// Big CTA. Table-wrapped rather than a styled <a> because Outlook ignores
// padding on inline anchors and the button collapses to bare text.
const cta = (url, label, colour) => `
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="background-color:${colour};border-radius:12px;">
                  <a href="${esc(href(url))}" style="display:inline-block;padding:15px 32px;font-family:${F_BODY};font-size:16px;font-weight:800;color:${C.milk};text-decoration:none;letter-spacing:0.3px;">
                    ${esc(label)}
                  </a>
                </td>
              </tr>
            </table>`;

// The code as a dashed ticket stub — the visual promise of the whole mail, so
// it gets the most weight after the headline. Dashed border and mono type
// read as "tear here", which is also the bakery's counter-ticket language.
const codeStub = (code, accent) => `
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center" style="background-color:${C.pink};border:2px dashed ${accent};border-radius:14px;padding:18px 16px;">
                  <div style="font-family:${F_MONO};font-size:10px;letter-spacing:2.5px;color:${C.cocoa};">USE&nbsp;CODE&nbsp;AT&nbsp;CHECKOUT</div>
                  <div style="font-family:${F_MONO};font-size:28px;font-weight:700;letter-spacing:4px;color:${C.choc};padding-top:8px;">${esc(code)}</div>
                </td>
              </tr>
            </table>`;

// Two-up product grid. Rendered as a table (not flex/grid) because Outlook's
// Word engine supports neither; on narrow screens the cells stack because the
// widths are percentages.
const productGrid = (items, currency) => {
  const list = Array.isArray(items) ? items.slice(0, 4) : [];
  if (!list.length) return '';
  const cell = (it) => `
                <td width="50%" valign="top" style="padding:8px;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${C.pink};border-radius:12px;">
                    <tr><td style="padding:14px 16px;">
                      <div style="font-family:${F_BODY};font-size:15px;font-weight:800;color:${C.choc};line-height:1.35;">${esc(it.name)}</div>
                      ${it.note ? `<div style="font-family:${F_BODY};font-size:13px;color:${C.cocoa};line-height:1.5;padding-top:4px;">${esc(it.note)}</div>` : ''}
                      ${it.price != null ? `<div style="font-family:${F_MONO};font-size:14px;color:${C.choc};padding-top:8px;">${esc(money(it.price, currency))}${it.wasPrice != null ? ` <span style="color:${C.cocoa};text-decoration:line-through;">${esc(money(it.wasPrice, currency))}</span>` : ''}</div>` : ''}
                    </td></tr>
                  </table>
                </td>`;
  const rows = [];
  for (let i = 0; i < list.length; i += 2) {
    rows.push(`<tr>${cell(list[i])}${list[i + 1] ? cell(list[i + 1]) : '<td width="50%">&nbsp;</td>'}</tr>`);
  }
  return `
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              ${rows.join('')}
            </table>`;
};

// Plain-text version of a product list, for the multipart/alternative part.
const productLines = (items, currency) => (Array.isArray(items) ? items : []).slice(0, 4).map((it) =>
  `  ${it.name}${it.price != null ? `  ${money(it.price, currency)}` : ''}${it.note ? ` — ${it.note}` : ''}`);

// --- promo: headline offer -------------------------------------------------
// The workhorse. A discount, a code, a deadline, an optional handful of
// products. Everything below the headline is optional, so the same template
// covers "20% off everything" and "free delivery this weekend".
function promoOffer(data = {}) {
  const currency = data.currency || '₹';
  const headline = data.headline || 'A little something from the counter';
  const subhead = data.subhead || '';
  const offer = data.offerLine || '';
  const code = data.code || '';
  const expires = data.expiresOn || '';
  const greeting = data.customerName ? `${esc(data.customerName)}, ` : '';
  const accent = C.straw;
  // 'Order now' lands on the shop by default.
  const ctaUrl = linkTo(data, data.ctaUrl, 'shop');
  const unsubscribeUrl = linkTo(data, data.unsubscribeUrl, 'unsubscribe');

  const body = `
        <tr>
          <td style="background-color:${C.milk};padding:10px 32px 0 32px;">
            <h1 style="margin:0;font-family:${F_BODY};font-size:30px;line-height:1.2;font-weight:800;color:${C.choc};">
              ${greeting}${esc(headline)}
            </h1>
            ${subhead ? `<p style="margin:12px 0 0 0;font-family:${F_BODY};font-size:16px;line-height:1.6;color:${C.cocoa};">${esc(subhead)}</p>` : ''}
          </td>
        </tr>
        ${offer ? `
        <tr>
          <td style="background-color:${C.milk};padding:20px 32px 0 32px;">
            <div style="background-color:${accent};border-radius:14px;padding:20px 22px;">
              <div style="font-family:${F_BODY};font-size:24px;font-weight:800;color:${C.milk};line-height:1.3;">${esc(offer)}</div>
            </div>
          </td>
        </tr>` : ''}
        ${code ? `
        <tr>
          <td style="background-color:${C.milk};padding:18px 32px 0 32px;">
            ${codeStub(code, accent)}
          </td>
        </tr>` : ''}
        ${expires ? `
        <tr>
          <td style="background-color:${C.milk};padding:14px 32px 0 32px;">
            <div style="font-family:${F_MONO};font-size:12px;letter-spacing:1px;color:${C.cocoa};text-align:center;">
              ENDS ${esc(String(expires).toUpperCase())}
            </div>
          </td>
        </tr>` : ''}
        ${data.items && data.items.length ? `
        <tr>
          <td style="background-color:${C.milk};padding:20px 24px 0 24px;">
            ${productGrid(data.items, currency)}
          </td>
        </tr>` : ''}
        <tr>
          <td align="center" style="background-color:${C.milk};padding:26px 32px 32px 32px;">
            ${cta(ctaUrl, data.ctaLabel || 'Order now', accent)}
          </td>
        </tr>`;

  const text = [
    `${data.customerName ? `${data.customerName}, ` : ''}${headline}`,
    subhead, '',
    offer,
    code ? `Use code at checkout: ${code}` : '',
    expires ? `Ends ${expires}` : '',
    ...(data.items && data.items.length ? ['', ...productLines(data.items, currency)] : []),
    ctaUrl ? `\n${data.ctaLabel || 'Order now'}: ${ctaUrl}` : '',
    unsubscribeUrl ? `\nUnsubscribe: ${unsubscribeUrl}` : ''
  ].filter(Boolean).join('\n');

  return {
    subject: data.subject || (offer ? `${offer} at Crumb & Ember` : headline),
    html: shell(headline, accent, { eyebrow: data.eyebrow || 'Offer', body, footer: marketingFooter(data) },
      data.preheader || [offer, expires ? `Ends ${expires}` : ''].filter(Boolean).join(' · ') || subhead || headline),
    text
  };
}

// --- promo: new arrivals ---------------------------------------------------
// No discount, no urgency — this one sells on the products themselves, so the
// grid carries the message and the accent shifts to butter to distinguish it
// in the inbox from a discount mail.
function promoNewArrivals(data = {}) {
  const currency = data.currency || '₹';
  const headline = data.headline || 'Fresh on the shelf this week';
  const subhead = data.subhead || 'Four new bakes, out of the oven from Thursday.';
  const accent = C.butter;
  // 'See the menu' lands on the menu by default.
  const ctaUrl = linkTo(data, data.ctaUrl, 'menu');
  const unsubscribeUrl = linkTo(data, data.unsubscribeUrl, 'unsubscribe');

  const body = `
        <tr>
          <td style="background-color:${C.milk};padding:10px 32px 0 32px;">
            <h1 style="margin:0;font-family:${F_BODY};font-size:29px;line-height:1.2;font-weight:800;color:${C.choc};">
              ${esc(headline)}
            </h1>
            <p style="margin:12px 0 0 0;font-family:${F_BODY};font-size:16px;line-height:1.6;color:${C.cocoa};">
              ${esc(subhead)}
            </p>
          </td>
        </tr>
        ${data.items && data.items.length ? `
        <tr>
          <td style="background-color:${C.milk};padding:20px 24px 0 24px;">
            ${productGrid(data.items, currency)}
          </td>
        </tr>` : ''}
        ${data.note ? `
        <tr>
          <td style="background-color:${C.milk};padding:20px 32px 0 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="background-color:${C.pink};border-left:4px solid ${accent};border-radius:0 10px 10px 0;padding:14px 16px;">
                  <div style="font-family:${F_BODY};font-size:14px;line-height:1.6;color:${C.choc};">${esc(data.note)}</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>` : ''}
        <tr>
          <td align="center" style="background-color:${C.milk};padding:26px 32px 32px 32px;">
            ${cta(ctaUrl, data.ctaLabel || 'See the menu', C.straw)}
          </td>
        </tr>`;

  const text = [
    headline, subhead, '',
    ...productLines(data.items, currency),
    data.note ? `\n${data.note}` : '',
    ctaUrl ? `\n${data.ctaLabel || 'See the menu'}: ${ctaUrl}` : '',
    unsubscribeUrl ? `\nUnsubscribe: ${unsubscribeUrl}` : ''
  ].filter(Boolean).join('\n');

  return {
    subject: data.subject || headline,
    html: shell(headline, accent, { eyebrow: data.eyebrow || 'New this week', body, footer: marketingFooter(data) },
      data.preheader || subhead),
    text
  };
}

// --- promo: loyalty reward -------------------------------------------------
// Earned, not offered — so it leads with the points balance rather than a
// discount, and uses the pistachio accent shared with order confirmations to
// signal "this is about your account", not a broadcast.
function promoLoyaltyReward(data = {}) {
  const currency = data.currency || '₹';
  const points = data.points != null ? String(data.points) : '';
  const tier = data.tier || '';
  const reward = data.rewardLine || 'A free coffee, on us';
  const code = data.code || '';
  const expires = data.expiresOn || '';
  const accent = C.pist;
  // 'Redeem now' lands on the account/rewards page by default.
  const ctaUrl = linkTo(data, data.ctaUrl, 'account/rewards');
  const unsubscribeUrl = linkTo(data, data.unsubscribeUrl, 'unsubscribe');
  const headline = data.headline || (data.customerName ? `${data.customerName}, you've earned this` : "You've earned this");

  const body = `
        <tr>
          <td style="background-color:${C.milk};padding:10px 32px 0 32px;">
            <h1 style="margin:0;font-family:${F_BODY};font-size:28px;line-height:1.25;font-weight:800;color:${C.choc};">
              ${esc(headline)}
            </h1>
          </td>
        </tr>
        ${points ? `
        <tr>
          <td style="background-color:${C.milk};padding:20px 32px 0 32px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center" style="background-color:${C.pink};border-radius:14px;padding:20px 16px;">
                  <div style="font-family:${F_MONO};font-size:36px;font-weight:700;color:${C.choc};line-height:1;">${esc(points)}</div>
                  <div style="font-family:${F_MONO};font-size:11px;letter-spacing:2.5px;color:${C.cocoa};padding-top:8px;">CRUMB&nbsp;POINTS${tier ? ` · ${esc(String(tier).toUpperCase())}` : ''}</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>` : ''}
        <tr>
          <td style="background-color:${C.milk};padding:20px 32px 0 32px;">
            <div style="background-color:${accent};border-radius:14px;padding:18px 22px;">
              <div style="font-family:${F_BODY};font-size:21px;font-weight:800;color:${C.milk};line-height:1.35;">${esc(reward)}</div>
            </div>
          </td>
        </tr>
        ${code ? `
        <tr>
          <td style="background-color:${C.milk};padding:18px 32px 0 32px;">
            ${codeStub(code, accent)}
          </td>
        </tr>` : ''}
        ${expires ? `
        <tr>
          <td style="background-color:${C.milk};padding:14px 32px 0 32px;">
            <div style="font-family:${F_MONO};font-size:12px;letter-spacing:1px;color:${C.cocoa};text-align:center;">
              REDEEM BY ${esc(String(expires).toUpperCase())}
            </div>
          </td>
        </tr>` : ''}
        <tr>
          <td align="center" style="background-color:${C.milk};padding:26px 32px 32px 32px;">
            ${cta(ctaUrl, data.ctaLabel || 'Redeem now', C.straw)}
          </td>
        </tr>`;

  const text = [
    headline, '',
    points ? `${points} Crumb points${tier ? ` · ${tier}` : ''}` : '',
    reward,
    code ? `Use code at checkout: ${code}` : '',
    expires ? `Redeem by ${expires}` : '',
    ctaUrl ? `\n${data.ctaLabel || 'Redeem now'}: ${ctaUrl}` : '',
    unsubscribeUrl ? `\nUnsubscribe: ${unsubscribeUrl}` : ''
  ].filter(Boolean).join('\n');

  return {
    subject: data.subject || reward,
    html: shell(headline, accent, { eyebrow: data.eyebrow || 'Crumb Club', body, footer: marketingFooter(data) },
      data.preheader || [reward, expires ? `Redeem by ${expires}` : ''].filter(Boolean).join(' · ')),
    text
  };
}

const TEMPLATES = {
  'verification-code': verificationCode,
  'order-confirmation': orderConfirmation,
  'promo-offer': promoOffer,
  'promo-new-arrivals': promoNewArrivals,
  'promo-loyalty-reward': promoLoyaltyReward
};

// Returns { subject, html, text }. The caller's explicit subject always wins,
// so a template can be reused for a resend or an A/B without a code change.
function render(name, data = {}, overrides = {}) {
  const fn = TEMPLATES[name];
  if (!fn) throw Object.assign(new Error(`unknown template: ${name}`), { permanent: true });
  const out = fn(data);
  return { ...out, subject: overrides.subject || out.subject };
}

module.exports = { render, TEMPLATES, templateNames: Object.keys(TEMPLATES), palette: C, esc, money };
