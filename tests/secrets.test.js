'use strict';
const test = require('node:test');
const assert = require('node:assert');
const S = require('../extension/js/secrets.js');

const WIN = process.platform === 'win32';

test('isSealed reconnait le prefixe', () => {
  assert.strictEqual(S.isSealed('dpapi:AAAA'), true);
  assert.strictEqual(S.isSealed('sk-ant-123'), false);
  assert.strictEqual(S.isSealed(''), false);
  assert.strictEqual(S.isSealed(null), false);
});

test('DPAPI : aller-retour avec la session Windows', { skip: !WIN }, () => {
  const keys = ['pexels-123', 'sk-ant-api03-éà€-xyz'];
  const sealed = S.seal(keys);
  assert.ok(sealed, 'chiffrement indisponible');
  assert.strictEqual(sealed.length, 2);
  sealed.forEach((v, i) => {
    assert.ok(S.isSealed(v));
    assert.ok(!v.includes(keys[i]), 'la cle ne doit pas apparaitre en clair');
  });
  assert.deepStrictEqual(S.unseal(sealed), keys);
});

test('DPAPI : une donnee abimee ou etrangere est refusee sans casser les autres', { skip: !WIN }, () => {
  const good = S.seal(['ma-cle'])[0];
  const out = S.unseal([good, 'dpapi:AAAA', 'pas-chiffree', 'dpapi:' + good.slice(6, -8) + 'AAAAAAAA']);
  assert.deepStrictEqual(out, ['ma-cle', null, null, null]);
});

function fakeApi() {
  const api = { sealCalls: 0, unsealCalls: 0, broken: false };
  api.seal = (vals) => {
    api.sealCalls++;
    return api.broken ? null : vals.map((v) => 'dpapi:' + Buffer.from(v).toString('base64'));
  };
  api.unseal = (vals) => {
    api.unsealCalls++;
    return api.broken ? null : vals.map((v) => (v === 'dpapi:ILLISIBLE' ? null : Buffer.from(v.slice(6), 'base64').toString()));
  };
  return api;
}

test('coffre : chiffre a l\'ecriture, dechiffre a la lecture, sans toucher au reste', () => {
  const api = fakeApi();
  const v = S.vault(['pexelsKey', 'claudeKey'], api);
  const b = { pexelsKey: 'p1', claudeKey: '', model: 'm' };
  const disk = v.sealedCopy(b);
  assert.deepStrictEqual(disk, { pexelsKey: 'dpapi:' + Buffer.from('p1').toString('base64'), claudeKey: '', model: 'm' });
  assert.strictEqual(b.pexelsKey, 'p1', 'l\'objet en memoire reste en clair');

  const v2 = S.vault(['pexelsKey', 'claudeKey'], api);
  const back = JSON.parse(JSON.stringify(disk));
  assert.strictEqual(v2.open(back), false);
  assert.deepStrictEqual(back, b);
});

test('coffre : PowerShell n\'est relance que si une cle change', () => {
  const api = fakeApi();
  const v = S.vault(['pexelsKey', 'claudeKey'], api);
  const b = { pexelsKey: 'p1', claudeKey: 'c1' };
  v.sealedCopy(b);
  v.sealedCopy(b);
  v.sealedCopy(b);
  assert.strictEqual(api.sealCalls, 1);
  b.claudeKey = 'c2';
  v.sealedCopy(b);
  assert.strictEqual(api.sealCalls, 2);

  // une cle relue du disque n'a pas besoin d'etre rechiffree
  const v2 = S.vault(['pexelsKey', 'claudeKey'], api);
  const back = v.sealedCopy(b);
  v2.open(back);
  const before = api.sealCalls;
  v2.sealedCopy(back);
  assert.strictEqual(api.sealCalls, before);
});

test('coffre : des cles en clair d\'une ancienne version sont signalees pour etre chiffrees', () => {
  const v = S.vault(['pexelsKey', 'claudeKey'], fakeApi());
  const b = { pexelsKey: 'ancienne', claudeKey: '' };
  assert.strictEqual(v.open(b), true);
  assert.strictEqual(b.pexelsKey, 'ancienne');
  assert.ok(S.isSealed(v.sealedCopy(b).pexelsKey));
});

test('coffre : une cle illisible (autre PC) est videe, a ressaisir', () => {
  const v = S.vault(['pexelsKey', 'claudeKey'], fakeApi());
  const b = { pexelsKey: 'dpapi:ILLISIBLE', claudeKey: '' };
  v.open(b);
  assert.strictEqual(b.pexelsKey, '');
  assert.strictEqual(v.sealedCopy(b).pexelsKey, '');
});

test('coffre : si PowerShell ne tourne pas, rien n\'est perdu', () => {
  const api = fakeApi();
  const v = S.vault(['pexelsKey', 'claudeKey'], api);
  const sealed = v.sealedCopy({ pexelsKey: 'p1', claudeKey: 'c1' });

  api.broken = true;
  const v2 = S.vault(['pexelsKey', 'claudeKey'], api);
  const b = JSON.parse(JSON.stringify(sealed));
  v2.open(b);
  assert.strictEqual(b.pexelsKey, '');
  // relecture impossible : on reecrit la version chiffree telle quelle
  assert.deepStrictEqual(v2.sealedCopy(b), sealed);
  // nouvelle cle saisie alors que le chiffrement ne marche pas : gardee en clair plutot que perdue
  b.claudeKey = 'nouvelle';
  const out = v2.sealedCopy(b);
  assert.strictEqual(out.claudeKey, 'nouvelle');
  assert.strictEqual(out.pexelsKey, sealed.pexelsKey);
});
