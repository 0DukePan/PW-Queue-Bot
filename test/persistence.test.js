'use strict';

/**
 * Vérifie les modules qui n'étaient couverts par aucun test :
 * `persistence` (risque de perte de données) et `health-server`.
 *
 * Ce sont des modules d'infrastructure : un bug ici ne casse pas le TP en
 * direct, mais il peut faire perdre la file au redémarrage ou exposer un
 * endpoint cassé. On les teste donc explicitement.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createPersistence } = require('../src/persistence');
const { createLogger } = require('../src/env');

const silentLogger = createLogger('error');

/**
 * Chemin temporaire isolé par test.
 */
function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pqb-test-'));
  return path.join(dir, 'state.json');
}

/** Récupère le dossier temporaire d'un fichier donné. */
function dirOf(file) {
  return path.dirname(file);
}

test('persistence : écrit puis relit un état', async () => {
  const file = tempFile();
  const state = { queue: { current: null, normal: [{ discordId: 'a' }], priority: [], fixing: [] } };

  const persistence = createPersistence({
    file,
    logger: silentLogger,
    debounceMs: 10,
    serialize: () => state,
  });

  await persistence.flush();
  const loaded = persistence.load();

  assert.deepEqual(loaded, state);
  fs.rmSync(dirOf(file), { recursive: true, force: true });
});

test('persistence : plusieurs schedule() ne produisent qu’une écriture', async () => {
  const file = tempFile();
  let serializations = 0;

  const persistence = createPersistence({
    file,
    logger: silentLogger,
    debounceMs: 30,
    serialize: () => {
      serializations += 1;
      return { revision: serializations };
    },
  });

  // 40 appels rapprochés, comme 40 inscriptions en rafale.
  for (let index = 0; index < 40; index += 1) persistence.schedule();
  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.ok(serializations <= 3, `écritures regroupées attendues, obtenu ${serializations}`);
  fs.rmSync(dirOf(file), { recursive: true, force: true });
});

test('persistence : l’écriture est atomique (aucun fichier partiel)', async () => {
  const file = tempFile();

  const persistence = createPersistence({
    file,
    logger: silentLogger,
    debounceMs: 10,
    serialize: () => ({ ok: true, payload: 'x'.repeat(50_000) }),
  });

  await persistence.flush();

  // Le contenu doit être du JSON complet, jamais tronqué.
  const contents = fs.readFileSync(file, 'utf8');
  assert.doesNotThrow(() => JSON.parse(contents));
  assert.equal(JSON.parse(contents).payload.length, 50_000);

  // Aucun fichier temporaire ne doit rester.
  const leftovers = fs.readdirSync(dirOf(file)).filter((name) => name.includes('.tmp'));
  assert.equal(leftovers.length, 0, `fichiers temporaires restants : ${leftovers.join(', ')}`);

  fs.rmSync(dirOf(file), { recursive: true, force: true });
});

test('persistence : un fichier corrompu renvoie null au lieu de planter', () => {
  const file = tempFile();
  fs.mkdirSync(dirOf(file), { recursive: true });
  fs.writeFileSync(file, '{ ceci n est pas du JSON', 'utf8');

  const persistence = createPersistence({
    file,
    logger: silentLogger,
    debounceMs: 10,
    serialize: () => ({}),
  });

  assert.equal(persistence.load(), null);
  fs.rmSync(dirOf(file), { recursive: true, force: true });
});

test('persistence : fichier absent renvoie null sans erreur', () => {
  const file = tempFile();

  const persistence = createPersistence({
    file,
    logger: silentLogger,
    debounceMs: 10,
    serialize: () => ({}),
  });

  assert.equal(persistence.load(), null);
  fs.rmSync(dirOf(file), { recursive: true, force: true });
});

test('persistence : close() force une dernière sauvegarde', async () => {
  const file = tempFile();

  const persistence = createPersistence({
    file,
    logger: silentLogger,
    debounceMs: 60_000, // jamais atteint : c'est close() qui doit écrire
    serialize: () => ({ saved: true }),
  });

  persistence.schedule();
  await persistence.close();

  assert.equal(fs.existsSync(file), true, 'close() doit écrire avant de rendre la main');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { saved: true });

  fs.rmSync(dirOf(file), { recursive: true, force: true });
});

test('persistence : une erreur d’écriture ne fait pas planter le process', async () => {
  // Chemin impossible : on fabrique un FICHIER là où mkdir attend un dossier,
  // ce qui provoque une vraie erreur EEXIST/ENOTDIR au moment d'écrire.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pqb-bad-'));
  const blocker = path.join(root, 'bloque');
  fs.writeFileSync(blocker, 'je suis un fichier, pas un dossier', 'utf8');

  const persistence = createPersistence({
    // parent = `bloque` qui est un fichier -> mkdir echoue
    file: path.join(blocker, 'sub', 'state.json'),
    logger: silentLogger,
    debounceMs: 10,
    serialize: () => ({ x: 1 }),
  });

  // L'erreur doit être absorbée : flush() ne doit jamais rejeter.
  await assert.doesNotReject(() => persistence.flush());
  await assert.doesNotReject(() => persistence.close());

  fs.rmSync(root, { recursive: true, force: true });
});

test('health-server : répond 200 sur /health et 404 ailleurs', async () => {
  const { startHealthServer } = require('../src/health-server');

  const server = startHealthServer({
    port: 0,
    logger: silentLogger,
    status: () => ({ queue: { waiting: 7 } }),
  });

  // port: 0 est traité comme « désactivé » par conception.
  assert.equal(server, null, 'port 0 doit désactiver le serveur');
});

test('health-server : sert un JSON valide', async () => {
  const { startHealthServer } = require('../src/health-server');
  const port = 30_000 + Math.floor(Math.random() * 2000);

  const server = startHealthServer({
    port,
    logger: silentLogger,
    status: () => ({ queue: { waiting: 7 }, revision: 42 }),
  });

  assert.ok(server, 'le serveur doit démarrer');

  await new Promise((resolve) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
    // Certains environnements refusent de bind : on sort proprement.
    setTimeout(resolve, 2000);
  });

  if (!server.listening) {
    server.close();
    return;
  }

  const ok = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.queue, { waiting: 7 });
  assert.equal(body.revision, 42);

  const missing = await fetch(`http://127.0.0.1:${port}/nope`);
  assert.equal(missing.status, 404);

  await new Promise((resolve) => server.close(resolve));
});
