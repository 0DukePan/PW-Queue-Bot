'use strict';

/**
 * Couvre l'assemblage (`src/bot.js`) : la seule partie qui n'était testée
 * nulle part, alors que c'est là que se concentre le risque d'intégration.
 *
 * On ne teste pas `client.login` (réseau), mais tout ce qui peut casser avant
 * ou après : détection du staff, construction de l'état, arrêt propre.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createStaffCheck, createBot } = require('../src/bot');
const { createConfig, createLogger } = require('../src/env');

const silentLogger = createLogger('error');

function tempConfig(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pqb-bot-'));
  const config = createConfig({
    DISCORD_TOKEN: 'fake',
    DISCORD_CLIENT_ID: '123',
    QUEUE_DATA_FILE: path.join(dir, 'state.json'),
    ...overrides,
  });
  return { config, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('isStaff : vrai pour un rôle Prof par défaut', () => {
  const isStaff = createStaffCheck(createConfig({ STAFF_ROLES: 'Prof,Délégué' }));

  const member = {
    roles: { cache: new Map([['r1', { id: 'r1', name: 'Prof' }]]) },
    permissions: { has: () => false },
  };

  assert.equal(isStaff(member), true);
});

test('isStaff : faux pour un rôle inconnu', () => {
  const isStaff = createStaffCheck(createConfig({ STAFF_ROLES: 'Prof,Délégué' }));

  const member = {
    roles: { cache: new Map([['r1', { id: 'r1', name: 'Étudiant' }]]) },
    permissions: { has: () => false },
  };

  assert.equal(isStaff(member), false);
});

test('isStaff : vrai par identifiant de rôle', () => {
  const isStaff = createStaffCheck(createConfig({ STAFF_ROLE_IDS: '999' }));

  const member = {
    roles: { cache: new Map([['999', { id: '999', name: 'PeuImporteLeNom' }]]) },
    permissions: { has: () => false },
  };

  assert.equal(isStaff(member), true);
});

test('isStaff : un administrateur est toujours accepté', () => {
  const isStaff = createStaffCheck(createConfig({}));

  const member = {
    roles: { cache: new Map() },
    permissions: { has: (flag) => flag === 'Administrator' },
  };

  assert.equal(isStaff(member), true);
});

test('isStaff : administrateur révoqué → non', () => {
  const isStaff = createStaffCheck(createConfig({}));

  const member = {
    roles: { cache: new Map() },
    permissions: { has: () => false },
  };

  assert.equal(isStaff(member), false);
});

test('isStaff : membre manquant ou sans cache ne plante pas', () => {
  const isStaff = createStaffCheck(createConfig({}));

  assert.equal(isStaff(null), false);
  assert.equal(isStaff(undefined), false);
  assert.equal(isStaff({}), false);
});

test('createBot s’assemble sans réseau et expose un statut', () => {
  const { config, cleanup } = tempConfig();

  const bot = createBot({ config, logger: silentLogger });

  const status = bot.status();
  assert.equal(status.queue.waiting, 0);
  assert.equal(status.queue.priority, 0);
  assert.equal(status.board, null);
  assert.equal(status.users, 'connecting');

  cleanup();
});

test('createBot restaure un état sauvegardé précédemment', () => {
  const { config, dir, cleanup } = tempConfig();
  const file = path.join(dir, 'state.json');

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      current: null,
      priority: [{ discordId: 'p1', nom: 'Benali', prenom: 'Yacine', groupe: '1' }],
      normal: [
        { discordId: 'n1', nom: 'Doe', prenom: 'Jane', groupe: '2' },
        { discordId: 'n2', nom: 'Smith', prenom: 'John', groupe: '3' },
      ],
      fixing: [],
    }),
    'utf8'
  );

  const bot = createBot({ config, logger: silentLogger });

  assert.equal(bot.store.size, 3, 'les 3 étudiants doivent être restaurés');
  assert.equal(bot.store.priority.size, 1);
  assert.equal(bot.store.normal.size, 2);
  assert.equal(bot.status().queue.waiting, 3);

  cleanup();
});

test('createBot ignore un fichier d’état corrompu', () => {
  const { config, dir, cleanup } = tempConfig();
  const file = path.join(dir, 'state.json');

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{{{ pas du json', 'utf8');

  // Ne doit pas lever : on démarre avec une file vide.
  const bot = createBot({ config, logger: silentLogger });
  assert.equal(bot.store.size, 0);

  cleanup();
});

test('stop() sur un bot jamais démarré ne plante pas', async () => {
  const { config, cleanup } = tempConfig();
  const bot = createBot({ config, logger: silentLogger });

  // `board.retire()` sur un panneau inexistant ne doit pas jeter.
  await assert.doesNotReject(() => bot.stop('test'));

  cleanup();
});
