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

// Read the public form contract without depending on presentational classes.
function attributes(source) {
  return Object.fromEntries([...source.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)].map(match => [match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? '']));
}

function htmlElements(html, name) {
  return [...html.matchAll(new RegExp(`<${name}\\b([^>]*)>`, 'gi'))].map(match => attributes(match[1]));
}

function htmlForms(html) {
  return [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)].map(match => ({
    ...attributes(match[1]),
    controls: [...match[2].matchAll(/<(input|textarea|button)\b([^>]*)>/gi)].map(control => ({ tag: control[1].toLowerCase(), ...attributes(control[2]) })),
    labels: htmlElements(match[2], 'label'),
  }));
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

const landingCases = [
  { name: 'mantención', slug: 'mantencion-reparacion-ascensores', origin: 'Instalación' },
  { name: 'accesibilidad', slug: 'accesibilidad-residencial-elevadores', origin: 'Accesibilidad' },
  { name: 'instalación', slug: 'instalacion-ascensores-montacargas', origin: 'instalacion-ascensores-montacargas' },
];

test('las tres landings muestran las mismas seis reseñas con foto, estrellas y enlace a Google', async () => {
  let reference;
  for (const landing of landingCases) {
    const html = await (await fetch(`${base}/${landing.slug}`)).text();
    const section = [...html.matchAll(/<section\b([^>]*)>([\s\S]*?)<\/section>/gi)]
      .find(match => attributes(match[1]).id === 'reviews');
    assert.ok(section, `${landing.name}: falta la sección de reseñas`);
    const cards = [...section[2].matchAll(/<article\b([^>]*)>([\s\S]*?)<\/article>/gi)]
      .filter(match => (attributes(match[1]).class || '').split(/\s+/).includes('review-card'));
    assert.equal(cards.length, 6, `${landing.name}: deben mostrarse las seis reseñas`);
    const reviews = [];
    for (const [index, card] of cards.entries()) {
      const label = `${landing.name}, reseña ${index + 1}`;
      const image = htmlElements(card[2], 'img')[0];
      assert.ok(image?.src, `${label}: falta la foto del autor`);
      const imageUrl = new URL(image.src, base);
      assert.ok(['http:', 'https:'].includes(imageUrl.protocol), `${label}: la foto debe tener una URL válida`);
      if (imageUrl.origin === base) {
        const response = await fetch(imageUrl);
        assert.equal(response.status, 200, `${label}: la foto debe estar disponible`);
        assert.match(response.headers.get('content-type') || '', /^image\//);
      }
      const stars = [...card[2].matchAll(/<([a-z][\w-]*)\b([^>]*)>([^<]*)<\/\1>/gi)]
        .find(match => (attributes(match[2]).class || '').split(/\s+/).includes('review-stars'));
      assert.ok(stars, `${label}: faltan las estrellas`);
      assert.match(attributes(stars[2])['aria-label'] || '', /^[1-5] de 5 estrellas$/, `${label}: la valoración debe ser accesible`);
      assert.match(stars[3], /[★☆]/, `${label}: las estrellas deben ser visibles`);
      const comment = card[2].match(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/i)?.[1].replace(/<[^>]+>/g, '').trim();
      assert.ok(comment, `${label}: falta el comentario`);
      const links = htmlElements(card[2], 'a');
      const googleLink = links.find(link => {
        try {
          const url = new URL(link.href);
          return url.protocol === 'https:' && /(^|\.)(google\.com|share\.google|maps\.app\.goo\.gl)$/.test(url.hostname);
        } catch { return false; }
      });
      assert.ok(googleLink, `${label}: falta el enlace a Google`);
      assert.equal(googleLink.target, '_blank', `${label}: Google debe abrirse en otra pestaña`);
      assert.ok((googleLink.rel || '').split(/\s+/).includes('noopener'), `${label}: falta noopener`);
      reviews.push({
        image: image.src,
        rating: attributes(stars[2])['aria-label'],
        comment,
        googleUrl: googleLink.href,
        text: card[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(),
      });
    }
    if (reference) assert.deepEqual(reviews, reference, `${landing.name}: las reseñas deben coincidir en las tres páginas`);
    else reference = reviews;
  }
});

for (const landing of landingCases) {
  test(`${landing.name} mantiene formularios accesibles compatibles con la API`, async () => {
    const html = await (await fetch(`${base}/${landing.slug}`)).text();
    const forms = htmlForms(html);
    assert.equal(forms.length, 2);
    assert.deepEqual(forms.map(item => item.controls.find(control => control.name === 'formulario')?.value).sort(), ['callback', 'hero']);
    for (const item of forms) {
      assert.equal(item.action, '/api/cotizacion');
      assert.equal(item.method.toLowerCase(), 'post');
      assert.equal(item.controls.find(control => control.name === 'pagina')?.value, landing.slug);
      for (const name of ['nombre', 'email', 'telefono']) {
        const field = item.controls.find(control => control.name === name);
        assert.ok(field, `Falta el campo ${name}`);
        assert.ok(Object.hasOwn(field, 'required'), `${name} debe ser obligatorio`);
        assert.ok(field.id && item.labels.some(label => label.for === field.id), `${name} debe tener etiqueta asociada`);
      }
      const phone = item.controls.find(control => control.name === 'telefono');
      assert.equal(phone.type, 'tel');
      const pattern = new RegExp(`^(?:${phone.pattern})$`, 'v');
      assert.ok(pattern.test('+56912345678'));
      assert.ok(!pattern.test('912345678'));
      assert.ok(!pattern.test('+56 912345678'));
      const message = item.controls.find(control => control.name === 'mensaje');
      if (message) {
        assert.ok(!Object.hasOwn(message, 'required'));
        assert.ok(Number(message.maxlength) > 0 && Number(message.maxlength) <= 4000);
      }
    }
  });

  test(`${landing.name} conserva navegación de campaña, medición y recursos de clientes`, async () => {
    const html = await (await fetch(`${base}/${landing.slug}`)).text();
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    assert.equal(ids.length, new Set(ids).size, 'Los IDs deben ser únicos');
    for (const id of ['banner', 'why-us', 'services', 'reviews', 'other-services', 'steps', 'faq', 'clientes']) assert.ok(ids.includes(id), `Falta destino de navegación ${id}`);
    const links = htmlElements(html, 'a');
    for (const link of links.filter(link => link.href?.startsWith('#'))) assert.ok(ids.includes(link.href.slice(1)), `Ancla inexistente ${link.href}`);
    assert.ok(!links.some(link => (link.href || '').startsWith(`/${landing.slug}#`)), 'Las anclas deben conservar la query de campaña');
    assert.ok(!links.some(link => /^javascript:/i.test(link.href || '')), 'Los enlaces deben funcionar sin JavaScript propio');
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'La interfaz no debe introducir manejadores JavaScript inline');
    assert.ok(links.some(link => link.href === 'tel:+56959382761'));
    assert.ok(links.some(link => link.href?.startsWith('https://api.whatsapp.com/send?phone=56959382761')));
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(match => attributes(match[1]).type !== 'application/ld+json');
    assert.equal(scripts.length, 1, 'El único script de interfaz debe ser el contenedor GTM existente');
    assert.match(scripts[0][2], /GTM-5TR6ZVP4/);
    assert.ok(![...html.matchAll(/\bclass="([^"]*)"/g)].some(match => match[1].split(/\s+/).includes('success')), 'La confirmación debe aparecer solo después de enviar');
    for (const logo of ['metro', 'honda', 'bice', 'eglo', 'carabineros', 'illapel', 'tacal', 'redsalud', 'consalud']) assert.match(html, new RegExp(`/assets/clientes/${logo}\\.png`));
  });

  test(`los dos formularios de ${landing.name} envían sus campos reales y conservan gclid y UTM`, async () => {
    const html = await (await fetch(`${base}/${landing.slug}`)).text();
    const referer = `${base}/${landing.slug}?gclid=prueba-campana&utm_source=google&utm_campaign=servicio`;
    for (const item of htmlForms(html)) {
      received = [];
      const data = new URLSearchParams(item.controls.filter(control => control.type === 'hidden').map(control => [control.name, control.value]));
      data.set('nombre', 'Prueba de mantenimiento');
      data.set('email', 'mantenimiento@example.test');
      data.set('telefono', '+56912345678');
      if (item.controls.some(control => control.name === 'mensaje')) data.set('mensaje', 'Consulta de prueba');
      const response = await fetch(`${base}${item.action}`, { method: 'POST', headers: { Origin: base, Referer: referer }, body: data, redirect: 'manual' });
      assert.equal(response.status, 303);
      assert.equal(received.length, 1);
      assert.equal(received[0].origen, landing.origin);
      assert.equal(received[0].producto, referer);
      assert.equal(received[0].nombre, data.get('nombre'));
      assert.equal(received[0].email, data.get('email'));
      assert.equal(received[0].telefono, data.get('telefono'));
      assert.equal(received[0].mensaje, data.get('formulario') === 'callback' ? `Solicitud de contacto desde: ${referer}` : data.get('mensaje'));
    }
  });
}
