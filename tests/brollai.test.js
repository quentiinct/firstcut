/* Tests du module IA contre un faux serveur API local (aucun appel reel, aucune cle).
 * On verifie la forme exacte des requetes envoyees par le SDK et la relecture des reponses. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const AI = require('../extension/js/brollai.js');

const EXT = path.join(__dirname, '..', 'extension');

/** Faux serveur : enregistre les requetes et rend la reponse demandee. */
function fakeApi(reply) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : null;
      seen.push({ url: req.url, headers: req.headers, body: parsed });
      const r = reply(parsed, seen.length);
      res.writeHead(r.status || 200, { 'content-type': 'application/json', 'request-id': 'req_test' });
      res.end(JSON.stringify(r.json));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: 'http://127.0.0.1:' + server.address().port }));
  });
}

function message(text, stop) {
  return {
    json: {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [{ type: 'text', text }],
      stop_reason: stop || 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 20 }
    }
  };
}

const INPUT = {
  params: { gapMin: 5, gapMax: 10, durMin: 2, durMax: 4 },
  sections: [[0, 60]],
  segments: [
    { a: 1, b: 5, text: 'Je vais vous parler de la montagne.' },
    { a: 20, b: 26, text: 'Puis on boit un cafe en terrasse.' }
  ],
  library: [{ id: 'L1', rel: 'drone/alpes.mp4', duration: 30, frames: [{ t: 10, caption: 'sommets enneiges' }] }]
};

test('planMoments : requete (modele, schema, repli serveur) et relecture bornee', async () => {
  const answer = {
    moments: [
      { start: 2, end: 9, phrase: 'la montagne', query: 'snowy mountain peaks', library_id: 'L1', library_t: 10 },
      { start: 3, end: 5, phrase: 'colle au precedent', query: 'x', library_id: '', library_t: -1 },
      { start: 21, end: 23, phrase: 'un cafe', query: 'coffee terrace', library_id: 'inconnu', library_t: 4 },
      { start: 90, end: 93, phrase: 'hors section', query: 'nope', library_id: '', library_t: -1 }
    ]
  };
  const api = await fakeApi(() => message(JSON.stringify(answer)));
  try {
    const r = await AI.planMoments({ apiKey: 'sk-test', baseURL: api.url, extensionDir: EXT }, INPUT);
    const req = api.seen[0];
    assert.ok(req.url.startsWith('/v1/messages'), req.url);
    assert.strictEqual(req.headers.authorization, 'Bearer sk-test');
    assert.ok(String(req.headers['anthropic-beta']).includes('server-side-fallback-2026-07-01'));
    assert.strictEqual(req.body.model, 'claude-opus-5-5');
    assert.strictEqual(req.body.fallbacks, 'default');
    assert.strictEqual(req.body.output_config.format.type, 'json_schema');
    assert.strictEqual(req.body.output_config.effort, 'medium');
    assert.ok(!('thinking' in req.body) && !('temperature' in req.body));
    const sent = JSON.parse(req.body.messages[0].content);
    assert.strictEqual(sent.transcription.length, 2);
    assert.strictEqual(sent.dossier[0].id, 'L1');

    // borne : duree max 4 s, colle -> ecarte, id inconnu -> banque, hors section -> ecarte
    assert.deepStrictEqual(
      r.moments.map((m) => [m.a, m.b, m.query, m.library && m.library.id]),
      [
        [2, 6, 'snowy mountain peaks', 'L1'],
        [21, 23, 'coffee terrace', null]
      ]
    );
    assert.strictEqual(r.moments[0].library.t, 10);
  } finally {
    api.server.close();
  }
});

test('Haiku : pas de repli serveur (non disponible sur ce modele)', async () => {
  const api = await fakeApi(() => message('{"moments":[]}'));
  try {
    await AI.planMoments({ apiKey: 'k', baseURL: api.url, extensionDir: EXT, model: 'claude-haiku-5-5' }, INPUT);
    const req = api.seen[0];
    assert.strictEqual(req.url, '/v1/messages');
    assert.ok(!('fallbacks' in req.body));
    assert.strictEqual(req.body.model, 'claude-haiku-5-5');
  } finally {
    api.server.close();
  }
});

test('describeClip : images en base64, effort bas, reponse relue', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adr-ai-'));
  const jpg = path.join(dir, 'f.jpg');
  fs.writeFileSync(jpg, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const api = await fakeApi(() =>
    message(JSON.stringify({ summary: 'Un drone survole les Alpes.', tags: ['montagne', 'neige'], frames: [{ t: 2, caption: 'sommets' }] }))
  );
  try {
    const r = await AI.describeClip({ apiKey: 'k', baseURL: api.url, extensionDir: EXT }, { name: 'alpes.mp4', frames: [{ t: 2, jpg }] });
    const content = api.seen[0].body.messages[0].content;
    assert.strictEqual(content[1].type, 'image');
    assert.strictEqual(content[1].source.media_type, 'image/jpeg');
    assert.strictEqual(content[1].source.data, '/9j/2Q==');
    assert.strictEqual(api.seen[0].body.output_config.effort, 'low');
    assert.deepStrictEqual(r.tags, ['montagne', 'neige']);
    assert.strictEqual(r.frames[0].caption, 'sommets');
  } finally {
    api.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('erreurs : cle refusee, refus du modele, reponse tronquee', async () => {
  const api = await fakeApi((body, n) => {
    if (n === 1) return { status: 401, json: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } };
    if (n === 2) return message('', 'refusal');
    return message('{"moments":[', 'max_tokens');
  });
  const o = { apiKey: 'k', baseURL: api.url, extensionDir: EXT };
  try {
    await assert.rejects(() => AI.planMoments(o, INPUT), /Clé API Claude refusée/);
    await assert.rejects(() => AI.planMoments(o, INPUT), /refusé/);
    await assert.rejects(() => AI.planMoments(o, INPUT), /tronquée/);
  } finally {
    api.server.close();
  }
});
