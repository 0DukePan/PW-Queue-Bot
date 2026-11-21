'use strict';

/**
 * Benchmark de la file d'attente : ancienne implémentation vs nouvelle.
 *
 * L'ancienne version (tableaux + `Array.prototype.some` + embed complet à
 * chaque clic) est reproduite ici à l'identique pour comparer honnêtement.
 *
 *   npm run bench
 */

const { EmbedBuilder } = require('discord.js');

const { QueueStore } = require('../src/queue-store');
const { buildPanelPayload } = require('../src/panel');

/** Longueur d'une file de TP réaliste pour un gros groupe. */
const QUEUE_SIZES = [30, 100, 500, 1000];
/** Nombre d'inscriptions simulées (une classe qui clique en rafale). */
const OPERATIONS = 2000;

/**
 * Ancienne structure : tableaux + recherche linéaire.
 */
class LegacyQueue {
  constructor() {
    this.normalQueue = [];
    this.priorityQueue = [];
    this.fixing = new Map();
    this.current = null;
  }

  alreadyIn(discordId) {
    // Reproduit exactement le code d'origine.
    return (
      this.current?.discordId === discordId ||
      this.priorityQueue.some((u) => u.discordId === discordId) ||
      this.normalQueue.some((u) => u.discordId === discordId) ||
      this.fixing.has(discordId)
    );
  }

  join(entry) {
    if (this.alreadyIn(entry.discordId)) return false;
    this.normalQueue.push({ ...entry, joinedAt: Date.now() });
    return true;
  }

  shift() {
    return this.normalQueue.shift() ?? null;
  }

  leave(discordId) {
    this.normalQueue = this.normalQueue.filter((u) => u.discordId !== discordId);
    this.priorityQueue = this.priorityQueue.filter((u) => u.discordId !== discordId);
    this.fixing.delete(discordId);
  }
}

/**
 * Construit l'embed complet à l'ancienne : toute la file est rendue, comme
 * dans `buildEmbed()` d'origine (EmbedBuilder inclus, pour une comparaison
 * honnête avec le nouveau rendu).
 *
 * @param {LegacyQueue} queue
 */
function legacyRender(queue) {
  const prioText =
    queue.priorityQueue.length > 0
      ? queue.priorityQueue
          .map((u, i) => `**${i + 1}.** ⚡ **${u.nom} ${u.prenom}** (G${u.groupe})`)
          .join('\n')
      : '*Vide*';

  const normalText =
    queue.normalQueue.length > 0
      ? queue.normalQueue
          .map((u, i) => `**${i + 1}.** **${u.nom} ${u.prenom}** (G${u.groupe})`)
          .join('\n')
      : '*Vide*';

  return new EmbedBuilder()
    .setTitle('File d’attente TP')
    .setColor(0x5865f2)
    .addFields(
      { name: '🎙️ En partage d’écran (Salon Vocal)', value: queue.current ? 'x' : '*Aucun*' },
      { name: '⚡ File de Rectifications', value: prioText },
      { name: '⏳ File d’attente (FIFO)', value: normalText },
      { name: '🔧 En cours d’ajustement (Rectification)', value: '*Aucun*' }
    )
    .setTimestamp()
    .toJSON();
}

/**
 * @param {() => void} fn
 */
function time(fn) {
  const started = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - started) / 1e6;
}

/**
 * @param {any} value
 */
function format(value) {
  return `${value.toFixed(2)} ms`.padStart(12);
}

console.log(
  `\nBenchmark — ${OPERATIONS} inscriptions + ${OPERATIONS} recherches de doublon\n` +
    `(recherche de doublon = ce qui tournait à CHAQUE clic, sur toute la file)\n`
);
console.log(
  'Taille file │        Ancienne │         Nouvelle │     Gain\n' +
    '────────────┼─────────────────┼──────────────────┼──────────'
);

/** @type {number[]} */
const speedups = [];

for (const size of QUEUE_SIZES) {
  const legacy = new LegacyQueue();
  for (let index = 0; index < size; index += 1) {
    legacy.join({ discordId: `p${index}`, nom: 'Nom', prenom: 'Prénom', groupe: '1' });
  }

  const modern = new QueueStore({ maxQueueLength: 10_000 });
  for (let index = 0; index < size; index += 1) {
    modern.join({ discordId: `p${index}`, nom: 'Nom', prenom: 'Prénom', groupe: '1' });
  }

  // Coût d'une vérification de doublon (sur un id absent : pire cas).
  const legacyMs = time(() => {
    for (let index = 0; index < OPERATIONS; index += 1) legacy.alreadyIn('absent');
  });

  const modernMs = time(() => {
    for (let index = 0; index < OPERATIONS; index += 1) modern.locate('absent');
  });

  const speedup = legacyMs / Math.max(modernMs, 0.0001);
  speedups.push(speedup);

  console.log(
    `${String(size).padStart(11)} │${format(legacyMs)} │${format(modernMs)} │${speedup
      .toFixed(0)
      .padStart(7)}×`
  );
}

console.log('\nRendu du panneau (ce qui part dans l’embed à chaque édition) :\n');
console.log(
  'Taille file │        Ancienne │         Nouvelle │     Gain\n' +
    '────────────┼─────────────────┼──────────────────┼──────────'
);

for (const size of QUEUE_SIZES) {
  const legacy = new LegacyQueue();
  for (let index = 0; index < size; index += 1) {
    legacy.join({ discordId: `p${index}`, nom: 'NomLong', prenom: 'PrénomLong', groupe: '1' });
  }

  const modern = new QueueStore({ maxQueueLength: 10_000 });
  for (let index = 0; index < size; index += 1) {
    modern.join({ discordId: `p${index}`, nom: 'NomLong', prenom: 'PrénomLong', groupe: '1' });
  }

  const runs = 200;
  let legacyBest = Infinity;
  let modernBest = Infinity;
  /** @type {string | null} */
  let legacyFailure = null;

  for (let index = 0; index < runs; index += 1) {
    if (!legacyFailure) {
      try {
        legacyBest = Math.min(legacyBest, time(() => legacyRender(legacy)));
      } catch (error) {
        // L'ancien rendu dépasse la limite Discord de 1024 caractères par champ.
        legacyFailure = error?.constructor?.name ?? 'Error';
      }
    }
    modernBest = Math.min(
      modernBest,
      time(() => buildPanelPayload(modern.getSnapshot({ pageSize: 8 }), { pageSize: 8 }))
    );
  }

  const modernJson = JSON.stringify(buildPanelPayload(modern.getSnapshot({ pageSize: 8 })));

  if (legacyFailure) {
    console.log(
      `${String(size).padStart(11)} │   ÉCHEC API │${format(modernBest)} │       —`
    );
    console.log(
      `              └ l’embed d’origine dépasse 1024 caractères : édition refusée par Discord`
    );
  } else {
    const speedup = legacyBest / Math.max(modernBest, 0.0001);
    const legacyJson = JSON.stringify(legacyRender(legacy));
    console.log(
      `${String(size).padStart(11)} │${format(legacyBest)} │${format(modernBest)} │${speedup
        .toFixed(1)
        .padStart(7)}×   (${(legacyJson.length / 1024).toFixed(0)} Ko → ${(
        modernJson.length / 1024
      ).toFixed(1)} Ko)`
    );
  }
}

const average = speedups.reduce((sum, value) => sum + value, 0) / speedups.length;
console.log(
  `\nRecherche de doublon : O(n) → O(1), gain moyen ${average.toFixed(0)}× sur ces tailles.`
);
console.log('Rendu du panneau    : O(n) → O(page), indépendant de la taille de la file.');
console.log(
  '\nEn prime, l’embed d’origine dépasse la limite Discord de 1024 caractères\n' +
    '(une ligne par étudiant) : passé ~30 inscrits, chaque clic lève une erreur\n' +
    'et le panneau ne se met plus à jour. La nouvelle version est bornée par\n' +
    'construction (page de 8 lignes + « … et N autres »).\n'
);
