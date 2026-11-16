'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');

let upstream;
let app;
let base;
let received = [];
let upstreamStatus = 200;
const slug = 'accesibilidad-residencial-elevadores';

before(async () => {
  upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.writeHead(upstreamStatus, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: upstreamStatus === 200 }));
  }).listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  process.env.COTIZACION_API_URL = `http://127.0.0.1:${upstream.address().port}/api/cotizacion`;
  process.env.FORM_CONFIRMATION_SECRET = 'test-secret-only';
  const { handler } = require('../server');
  app = http.createServer((req, res) => handler(req, res).catch(() => { res.statusCode = 500; res.end(); })).listen(0, '127.0.0.1');
  await once(app, 'listening');
  base = `http://127.0.0.1:${app.address().port}`;
  process.env.PUBLIC_BASE_URL = base;
});

after(async () => {
  await Promise.all([new Promise(resolve => app.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
});

function form(overrides = {}) {
  return new URLSearchParams({ pagina: slug, formulario: 'hero', nombre: 'Cliente de prueba', email: 'cliente@example.test', telefono: '+56912345678', mensaje: 'Prueba', ...overrides });
}

test('entrega la página solicitada y rechaza archivos internos', async () => {
  const page = await fetch(`${base}/${slug}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /^text\/html/);
  const secretFile = await fetch(`${base}/server.js`);
  assert.equal(secretFile.status, 404);
});

test('entrega los recursos compartidos sin exponer archivos fuera de assets', async () => {
  const stylesheet = await fetch(`${base}/assets/clientes.css`);
  assert.equal(stylesheet.status, 200);
  assert.match(stylesheet.headers.get('content-type'), /^text\/css/);
  assert.equal((await fetch(`${base}/assets`)).status, 404);
  assert.equal((await fetch(`${base}/assets/%2e%2e%2fserver.js`)).status, 404);
  assert.equal((await fetch(`${base}/assets/%2e%2e%5cserver.js`)).status, 404);
  assert.equal((await fetch(`${base}/assets/.env`)).status, 404);
  assert.equal((await fetch(`${base}/assets/missing.png`)).status, 404);
});

test('envía JSON al servicio y muestra la confirmación solo tras el éxito', async () => {
  received = [];
  const response = await fetch(`${base}/api/cotizacion`, { method: 'POST', headers: { Referer: `${base}/${slug}?utm_source=test` }, body: form(), redirect: 'manual' });
  assert.equal(response.status, 303);
  assert.deepEqual(received, [{ nombre: 'Cliente de prueba', email: 'cliente@example.test', telefono: '+56912345678', mensaje: 'Prueba', producto: `${base}/${slug}?utm_source=test`, origen: 'Accesibilidad' }]);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  const receipt = await fetch(`${base}/gracias`, { headers: { Cookie: cookie } });
  assert.equal(receipt.status, 200);
  assert.match(await receipt.text(), /class="success"/);
  assert.match(receipt.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await fetch(`${base}/gracias`)).status, 404);
  assert.equal((await fetch(`${base}/gracias`, { headers: { Cookie: `${cookie}0` } })).status, 404);
});

test('callback conserva origen y mensaje esperado', async () => {
  received = [];
  const response = await fetch(`${base}/api/cotizacion`, { method: 'POST', body: form({ formulario: 'callback' }), redirect: 'manual' });
  assert.equal(response.status, 303);
  assert.equal(received[0].mensaje, `Solicitud de contacto desde: ${base}/${slug}`);
});

test('rechaza datos inválidos sin llamar a la API', async () => {
  received = [];
  const response = await fetch(`${base}/api/cotizacion`, { method: 'POST', body: form({ telefono: '123', email: 'incorrecto' }) });
  assert.equal(response.status, 400);
  assert.equal(received.length, 0);
  assert.doesNotMatch(await response.text(), /class="success"/);
});

test('rechaza formularios desde otro origen y cuerpos demasiado grandes', async () => {
  received = [];
  const crossOrigin = await fetch(`${base}/api/cotizacion`, { method: 'POST', headers: { Origin: 'https://otro.example' }, body: form() });
  assert.equal(crossOrigin.status, 403);
  const oversized = await fetch(`${base}/api/cotizacion`, { method: 'POST', body: form({ mensaje: 'x'.repeat(66000) }) });
  assert.equal(oversized.status, 413);
  assert.equal(received.length, 0);
});

test('admite mensajes largos con caracteres Unicode dentro del límite', async () => {
  received = [];
  const mensaje = 'á'.repeat(4000);
  const response = await fetch(`${base}/api/cotizacion`, { method: 'POST', body: form({ mensaje }), redirect: 'manual' });
  assert.equal(response.status, 303);
  assert.equal(received[0].mensaje, mensaje);
});

test('no permite barras invertidas en las rutas de archivos', async () => {
  const response = await fetch(`${base}/${slug}/%5c..%5c..%5cserver.js`);
  assert.equal(response.status, 404);
});

test('no registra conversión si falla el servicio receptor', async () => {
  upstreamStatus = 500;
  const response = await fetch(`${base}/api/cotizacion`, { method: 'POST', body: form() });
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /class="success"/);
  upstreamStatus = 200;
});
