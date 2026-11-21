'use strict';

/**
 * Tests du cœur métier : file d'attente, rendu du panneau, configuration.
 *
 * Aucune dépendance externe n'est requise (node:test + node:assert), et aucun
 * accès réseau : ces tests valident la logique qui doit rester correcte quand
 * la file est pleine.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  QueueStore,
  QueueError,
  validateStudentFields,
  normalizeText,
} = require('../src/queue-store');
const { buildPanelPayload, renderSection, displayName } = require('../src/panel');
const { createConfig, parseDotEnv } = require('../src/env');

/** @param {string} id */
function student(id, overrides = {}) {
  return {
    discordId: id,
    nom: `Nom${id}`,
    prenom: `Prenom${id}`,
    groupe: '1',
    ...overrides,
  };
}

test('join ajoute un étudiant et renvoie sa position', () => {
  const store = new QueueStore();
  store.join(student('a'));
  store.join(student('b'));

  assert.equal(store.normal.size, 2);
  assert.equal(store.positionOf('a'), 1);
  assert.equal(store.positionOf('b'), 2);
  assert.equal(store.locate('a'), 'normal');
});

test('join refuse les doublons en O(1) et quelle que soit la file', () => {
  const store = new QueueStore();
  store.join(student('a'));

  assert.throws(() => store.join(student('a')), QueueError);

  store.current = { ...student('b'), joinedAt: Date.now() };
  assert.throws(() => store.join(student('b')), /déjà/);
});

test('join valide le groupe et les noms', () => {
  const store = new QueueStore();
  assert.throws(() => store.join({ ...student('a'), groupe: '4' }), QueueError);
  assert.throws(() => store.join({ ...student('a'), nom: '   ' }), QueueError);
});

test('advance sert les rectifications avant la file normale', () => {
  const store = new QueueStore();
  store.join(student('a'));
  store.join(student('b'));

  const first = store.advance();
  assert.equal(first.next?.discordId, 'a');
  assert.equal(store.current?.discordId, 'a');

  store.sendCurrentToFixing();
  assert.equal(store.fixing.size, 1);

  store.markFixed('a');
  assert.equal(store.priority.size, 1);

  const second = store.advance();
  assert.equal(second.next?.discordId, 'a');
  assert.equal(second.next?.isPriority, true);
});

test('advance sans personne ne casse rien', () => {
  const store = new QueueStore();
  const { next } = store.advance();
  assert.equal(next, null);
  assert.equal(store.current, null);
});

test('leave retire l étudiant de toutes les files', () => {
  const store = new QueueStore();
  store.join(student('a'));
  store.join(student('b'));
  store.advance();

  assert.equal(store.leave('a'), true);
  assert.equal(store.current, null);
  assert.equal(store.leave('inconnu'), false);
});

test('markFixed refuse un étudiant qui n’est pas en rectification', () => {
  const store = new QueueStore();
  assert.throws(() => store.markFixed('a'), /rectification/);
});

test('positionOf tient compte des rectifications', () => {
  const store = new QueueStore();
  store.join(student('a'));
  store.join(student('b'));
  store.advance();
  store.sendCurrentToFixing();
  store.markFixed('a');
  store.join(student('c'));

  assert.equal(store.positionOf('a'), 1);
  assert.equal(store.positionOf('b'), 2);
  assert.equal(store.positionOf('c'), 3);
});

test('getSnapshot borne la page et expose les totaux', () => {
  const store = new QueueStore();
  for (let index = 0; index < 50; index += 1) store.join(student(`u${index}`));

  const snapshot = store.getSnapshot({ pageSize: 8 });
  assert.equal(snapshot.normal.total, 50);
  assert.equal(snapshot.normal.items.length, 8);
  assert.equal(snapshot.totals.waiting, 50);
  assert.equal(snapshot.normal.items[0].discordId, 'u0');
});

test('getSnapshot ne parcourt pas toute la file (page bornée)', () => {
  // File volontairement énorme (au-delà du garde-fou par défaut) pour mesurer
  // le coût du rendu, pas la limite mémoire.
  const store = new QueueStore({ maxQueueLength: 10_000 });
  for (let index = 0; index < 5000; index += 1) store.join(student(`big${index}`));

  // Mesure du coût *unitaire* après échauffement : le rendu doit être
  // indépendant de la taille de la file (O(page), pas O(n)).
  const snapshot = store.getSnapshot({ pageSize: 8 });
  assert.equal(snapshot.normal.items.length, 8);

  const iterations = 200;
  let best = Infinity;
  for (let index = 0; index < iterations; index += 1) {
    const started = process.hrtime.bigint();
    buildPanelPayload(store.getSnapshot({ pageSize: 8 }), { pageSize: 8 });
    best = Math.min(best, Number(process.hrtime.bigint() - started) / 1e6);
  }

  assert.ok(
    best < 1,
    `le rendu doit coûter < 1 ms quel que soit n (5000 étudiants), obtenu ${best.toFixed(3)} ms`
  );
});

test('serialize / restore conserve l’ordre et l’état', () => {
  const store = new QueueStore();
  store.join(student('a'));
  store.join(student('b'));
  store.advance();
  store.sendCurrentToFixing();

  const restored = new QueueStore({ persistedState: store.serialize() });
  assert.equal(restored.size, store.size);
  assert.equal(restored.fixing.size, 1);
  assert.deepEqual(
    [...restored.normal.keys()],
    [...store.normal.keys()]
  );
});

test('restore ignore les entrées corrompues', () => {
  const store = new QueueStore({
    persistedState: {
      normal: [{ discordId: 'ok', nom: 'N', prenom: 'P', groupe: '2' }, { nom: 'sans id' }, null],
      priority: 'pas un tableau',
    },
  });

  assert.equal(store.normal.size, 1);
  assert.equal(store.priority.size, 0);
});

test('movePriority réordonne la file prioritaire', () => {
  // État construit via `restore` : c'est la seule façon légitime de placer
  // trois étudiants en rectification sans que `advance` ne les resserve.
  const store = new QueueStore({
    persistedState: {
      priority: [
        { ...student('a'), priorityAt: 1 },
        { ...student('b'), priorityAt: 2 },
        { ...student('c'), priorityAt: 3 },
      ],
    },
  });

  assert.deepEqual([...store.priority.keys()], ['a', 'b', 'c']);
  assert.equal(store.movePriority('c', -2), 1);
  assert.deepEqual([...store.priority.keys()], ['c', 'a', 'b']);
  assert.equal(store.movePriority('a', 5), 3, 'les bornes sont respectées');
  assert.deepEqual([...store.priority.keys()], ['c', 'b', 'a']);
  assert.equal(store.movePriority('inconnu', 1), -1);
});

test('buildPanelPayload reste sous les limites de Discord', () => {
  const store = new QueueStore();
  for (let index = 0; index < 60; index += 1) {
    store.join(
      student(`u${index}`, {
        nom: 'NomTrèsLongQuiPourraitDépasserLaLimite',
        prenom: 'PrénomToutAussiLongQueLeNom',
      })
    );
  }

  const payload = buildPanelPayload(store.getSnapshot({ pageSize: 20 }), { pageSize: 20 });
  const embed = payload.embeds[0].toJSON();

  for (const field of embed.fields) {
    assert.ok(field.value.length <= 1024, `champ trop long : ${field.value.length}`);
    assert.ok(field.name.length <= 256);
  }
  assert.ok(embed.footer.text.length <= 2048);
  assert.equal(payload.components.length, 2);
});

test('buildPanelPayload signale les étudiants masqués', () => {
  const store = new QueueStore();
  for (let index = 0; index < 12; index += 1) store.join(student(`u${index}`));

  const payload = buildPanelPayload(store.getSnapshot({ pageSize: 8 }), { pageSize: 8 });
  const fifo = payload.embeds[0].toJSON().fields[2].value;
  assert.match(fifo, /et 4 autres en attente/);
});

test('renderSection gère la section vide', () => {
  assert.equal(renderSection({ total: 0, items: [] }), '*Vide*');
});

test('displayName tronque les noms trop longs', () => {
  const long = 'A'.repeat(40);
  const truncated = displayName(long);
  assert.ok(truncated.length <= 24);
  assert.ok(truncated.endsWith('…'));
});

test('normalizeText compacte les espaces', () => {
  assert.equal(normalizeText('  Jean   Paul  '), 'Jean Paul');
  assert.equal(normalizeText(undefined), '');
});

test('validateStudentFields accepte un groupe valide', () => {
  assert.deepEqual(
    validateStudentFields({ nom: 'Doe', prenom: 'Jane', groupe: '3', discordId: 'x' }),
    { nom: 'Doe', prenom: 'Jane', groupe: '3' }
  );
});

test('createConfig applique les valeurs par défaut', () => {
  const config = createConfig({ DISCORD_TOKEN: 't', DISCORD_CLIENT_ID: 'c' });
  assert.equal(config.token, 't');
  assert.deepEqual(config.staffRoles, ['Prof', 'Délégué']);
  assert.equal(config.queuePageSize, 8);
});

test('createConfig lit les listes et bornes les entiers', () => {
  const config = createConfig({
    DISCORD_TOKEN: 't',
    DISCORD_CLIENT_ID: 'c',
    STAFF_ROLES: 'Prof, Délégué, Admin',
    QUEUE_PAGE_SIZE: '999',
    LOG_LEVEL: 'debug',
  });

  assert.deepEqual(config.staffRoles, ['Prof', 'Délégué', 'Admin']);
  assert.equal(config.queuePageSize, 20, 'page size doit être plafonnée');
  assert.equal(config.logLevel, 'debug');
});

test('parseDotEnv ignore commentaires et quotes', () => {
  const parsed = parseDotEnv(['# commentaire', 'A=1', 'export B="deux"', 'C=\'trois\'', 'invalide'].join('\n'));
  assert.equal(parsed.get('A'), '1');
  assert.equal(parsed.get('B'), 'deux');
  assert.equal(parsed.get('C'), 'trois');
  assert.equal(parsed.has('invalide'), false);
});
