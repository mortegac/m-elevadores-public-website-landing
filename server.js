'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const ROOT = __dirname;
const ROUTES = {
  'accesibilidad-residencial-elevadores': 'Accesibilidad',
  'instalacion-ascensores-montacargas': 'instalacion-ascensores-montacargas',
  // La API actual clasifica esta ruta como «Instalación»; se conserva el
  // contrato hasta confirmar cómo procesa el origen el servicio receptor.
  'mantencion-reparacion-ascensores': 'Instalación',
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const SECRET = process.env.FORM_CONFIRMATION_SECRET || crypto.randomBytes(32).toString('hex');
const UPSTREAM = process.env.COTIZACION_API_URL || 'https://www.melevadores.cl/api/cotizacion';
// URL-encoded UTF-8 can use several bytes per character (including emoji).
const MAX_BODY = 64 * 1024;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function signed(value) {
  const mac = crypto.createHmac('sha256', SECRET).update(value).digest('hex');
  return `${value}.${mac}`;
}

function validReceipt(token) {
  if (!token || token.length > 256) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || !/^\d+$/.test(parts[1]) || !/^[a-f0-9]{64}$/.test(parts[2])) return null;
  const [slug, stamp, signature] = parts;
  if (!Object.hasOwn(ROUTES, slug) || Date.now() - Number(stamp) > 10 * 60 * 1000 || Number(stamp) > Date.now()) return null;
  const expected = signed(`${slug}.${stamp}`).split('.')[2];
  if (!crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) return null;
  return slug;
}

function cookie(req, name) {
  const part = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${name}=`));
  return part ? part.slice(name.length + 1) : '';
}

function receiptPage(title, message, back, success) {
  const gtm = success ? `<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','GTM-5TR6ZVP4');</script>` : '';
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)} | M-Elevadores</title><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Quicksand:wght@400;600;700&display=swap" rel="stylesheet">${gtm}<style>body{margin:0;font-family:Quicksand,sans-serif;color:#243c70;background:#f0f4ff}header{background:#243c70;padding:1.25rem 5%}header img{width:200px;max-width:80%;height:auto}main{max-width:38rem;margin:10vh auto;padding:2rem;background:white;border-radius:12px;box-shadow:0 3px 16px #243c7020}h1{color:#3962e9}a.button{display:inline-block;margin-top:1rem;padding:.8rem 1.2rem;background:#0070f3;color:white;border-radius:8px;text-decoration:none;font-weight:700}</style></head><body>${success ? '<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-5TR6ZVP4" height="0" width="0" style="display:none;visibility:hidden" title="Google Tag Manager"></iframe></noscript>' : ''}<header><img src="https://images.prismic.io/m-elevadores/aCeGwCdWJ-7kSPL1_image.png?auto=format,compress" alt="M-Elevadores"></header><main><h1>${escapeHtml(title)}</h1><p${success ? ' class="success"' : ''}>${escapeHtml(message)}</p><a class="button" href="/${escapeHtml(back)}/">Volver a la página</a></main></body></html>`;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(body);
}

async function readForm(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('too-large');
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function sourceUrl(req, slug) {
  const fallback = (process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '') + '/' + slug;
  try {
    const ref = new URL(req.headers.referer);
    const base = new URL(process.env.PUBLIC_BASE_URL || `http://${req.headers.host}`);
    if (ref.origin === base.origin && ref.pathname.replace(/\/$/, '') === '/' + slug) return ref.href;
  } catch { /* Form requests may legitimately omit the Referer. */ }
  return fallback;
}

async function handlePost(req, res) {
  if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/x-www-form-urlencoded')) return send(res, 415, 'Formato no compatible.');
  if (req.headers.origin) {
    try {
      const expected = new URL(process.env.PUBLIC_BASE_URL || `http://${req.headers.host}`).origin;
      if (req.headers.origin !== expected) return send(res, 403, 'Origen no permitido.');
    } catch { return send(res, 403, 'Origen no permitido.'); }
  }
  if (Number(req.headers['content-length'] || 0) > MAX_BODY) return send(res, 413, 'El formulario es demasiado grande.');
  let form;
  try { form = await readForm(req); } catch { return send(res, 413, 'El formulario es demasiado grande.'); }
  const slug = form.get('pagina');
  if (!Object.hasOwn(ROUTES, slug)) return send(res, 400, 'Página no válida.');
  const back = slug;
  const kind = form.get('formulario');
  const nombre = (form.get('nombre') || '').trim();
  const email = (form.get('email') || '').trim();
  const telefono = (form.get('telefono') || '').trim();
  const mensaje = (form.get('mensaje') || '').trim();
  if (!['hero', 'callback'].includes(kind) || nombre.length < 2 || nombre.length > 150 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || !/^\+\d{6,12}$/.test(telefono) || mensaje.length > 4000) {
    return send(res, 400, receiptPage('Revisa tus datos', 'Comprueba el nombre, correo y teléfono. El teléfono debe incluir el código de país, por ejemplo +56912345678.', back, false), { 'Cache-Control': 'no-store' });
  }
  const producto = sourceUrl(req, slug);
  const data = { nombre, email, telefono, producto, mensaje: kind === 'callback' ? `Solicitud de contacto desde: ${producto}` : mensaje, origen: ROUTES[slug] };
  try {
    const response = await fetch(UPSTREAM, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal: AbortSignal.timeout(15000) });
    const result = await response.json().catch(() => null);
    if (!response.ok || result?.ok !== true) throw new Error('upstream-failure');
  } catch {
    return send(res, 502, receiptPage('No pudimos enviar tu solicitud', 'Inténtalo nuevamente o contáctanos directamente por teléfono o WhatsApp.', back, false), { 'Cache-Control': 'no-store' });
  }
  const token = signed(`${slug}.${Date.now()}`);
  const secure = (process.env.PUBLIC_BASE_URL || '').startsWith('https://') ? '; Secure' : '';
  res.writeHead(303, { Location: '/gracias', 'Set-Cookie': `m_elevadores_receipt=${token}; HttpOnly; SameSite=Lax; Path=/gracias; Max-Age=600${secure}`, 'Cache-Control': 'no-store' });
  return res.end();
}

async function handler(req, res) {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return send(res, 400, 'Solicitud no válida.'); }
  if (url.pathname === '/api/cotizacion' && req.method === 'POST') return handlePost(req, res);
  if (url.pathname === '/gracias' && req.method === 'GET') {
    const slug = validReceipt(cookie(req, 'm_elevadores_receipt'));
    const clear = 'm_elevadores_receipt=; HttpOnly; SameSite=Lax; Path=/gracias; Max-Age=0';
    if (!slug) return send(res, 404, 'Esta confirmación no está disponible.', { 'Set-Cookie': clear, 'Cache-Control': 'no-store' });
    return send(res, 200, receiptPage('¡Gracias!', '¡Gracias! Te contactaremos pronto.', slug, true), { 'Set-Cookie': clear, 'Cache-Control': 'no-store' });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Método no permitido.', { Allow: 'GET, HEAD' });
  if (url.pathname === '/') {
    return send(res, 200, '<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>M-Elevadores</title></head><body><h1>M-Elevadores</h1><ul>' + Object.keys(ROUTES).map(slug => `<li><a href="/${slug}/">${slug.replaceAll('-', ' ')}</a></li>`).join('') + '</ul></body></html>');
  }
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return send(res, 400, 'Ruta no válida.'); }
  const segments = pathname.split('/').filter(Boolean);
  if (!segments.length || !Object.hasOwn(ROUTES, segments[0]) || segments.some(s => s === '.' || s === '..' || s.startsWith('.') || s.includes('\\'))) return send(res, 404, 'Página no encontrada.');
  if (segments.length === 1) segments.push('index.html');
  const extension = path.extname(segments.at(-1)).toLowerCase();
  if (!Object.hasOwn(TYPES, extension)) return send(res, 404, 'Página no encontrada.');
  try {
    const data = await fs.readFile(path.join(ROOT, ...segments));
    res.writeHead(200, { 'Content-Type': TYPES[extension], 'X-Content-Type-Options': 'nosniff', 'Cache-Control': extension === '.html' ? 'no-cache' : 'public, max-age=3600' });
    return res.end(req.method === 'HEAD' ? undefined : data);
  } catch { return send(res, 404, 'Página no encontrada.'); }
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  http.createServer((req, res) => handler(req, res).catch(() => send(res, 500, 'Error interno.'))).listen(port, () => console.log(`M-Elevadores disponible en http://localhost:${port}`));
}

module.exports = { handler };
