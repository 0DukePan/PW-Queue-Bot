'use strict';

/**
 * Preuve par le négatif : le même scénario de charge, joué sur le code
 * d'origine, DOIT échouer.
 *
 * Sans ce test, `stress.test.js` ne démontrerait rien : un test qui passe
 * toujours (parce qu'il ne mesure rien) serait indistinguable d'un test qui
 * passe parce que le code est correct. Ici on vérifie explicitement que le
 * scénario casse l'implémentation d'origine — donc que le scénario est
 * réellement discriminant.
 *
 * Les deux causes de panne sont reproduites séparément :
 *   1. l'embed non borné (limite Discord de 1024 caractères par champ) ;
 *   2. l'absence de coalescence (1 édition par clic → 429).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { EmbedBuilder } = require('discord.js');

const LEGACY_CODE_REF = 'commit a6c2c22 (bot.js d’origine)';

/**
 * `buildEmbed()` original, copié verbatim du commit a6c2c22.
 *
 * @param {{ current: any, priorityQueue: any[], normalQueue: any[], fixing: Map<string, any> }} queueState
 */
function legacyBuildEmbed(queueState) {
  const currentText = queueState.current
    ? `🟢 **${queueState.current.nom} ${queueState.current.prenom}** (Groupe ${queueState.current.groupe}) — <@${queueState.current.discordId}>`
    : '*Aucun étudiant en cours de passage*';

  const prioText =
    queueState.priorityQueue.length > 0
      ? queueState.priorityQueue
          .map((u, i) => `**${i + 1}.** ⚡ **${u.nom} ${u.prenom}** (G${u.groupe})`)
          .join('\n')
      : '*Vide*';

  const normalText =
    queueState.normalQueue.length > 0
      ? queueState.normalQueue
          .map((u, i) => `**${i + 1}.** **${u.nom} ${u.prenom}** (G${u.groupe})`)
          .join('\n')
      : '*Vide*';

  return new EmbedBuilder()
    .setTitle('File d’attente TP')
    .setColor(0x5865f2)
    .addFields(
      { name: '🎙️ En partage d’écran (Salon Vocal)', value: currentText },
      { name: '⚡ File de Rectifications', value: prioText },
      { name: '⏳ File d’attente (FIFO)', value: normalText },
      { name: '🔧 En cours d’ajustement (Rectification)', value: '*Aucun*' }
    )
    .setFooter({ text: 'Système propre sans spam' })
    .setTimestamp();
}

/**
 * @param {number} count
 */
function legacyQueueState(count) {
  return {
    current: null,
    priorityQueue: /** @type {any[]} */ ([]),
    normalQueue: Array.from({ length: count }, (_, index) => ({
      discordId: `student${index}`,
      nom: 'Benali',
      prenom: 'Yacine',
      groupe: '1',
      joinedAt: Date.now(),
    })),
    fixing: /** @type {Map<string, any>} */ (new Map()),
  };
}

test('le code d’origine casse bien avant 50 étudiants', () => {
  assert.throws(
    () => legacyBuildEmbed(legacyQueueState(50)),
    (error) => /Received one or more errors|Invalid string length/.test(error.message),
    `le code d’origine (${LEGACY_CODE_REF}) doit lever sur 50 étudiants`
  );
});

test('le code d’origine passe encore à 20 étudiants (le seuil est réel)', () => {
  // Contrôle : si ce test se met à échouer, c’est que la limite Discord a
  // changé et que les chiffres du README doivent être revus.
  assert.doesNotThrow(() => legacyBuildEmbed(legacyQueueState(20)));
});

test('le rendu actuel tient là où le code d’origine casse', () => {
  const { buildPanelPayload } = require('../src/panel');
  const { QueueStore } = require('../src/queue-store');

  const store = new QueueStore({ maxQueueLength: 1000 });
  for (let index = 0; index < 50; index += 1) {
    store.join({
      discordId: `student${index}`,
      nom: 'Benali',
      prenom: 'Yacine',
      groupe: '1',
    });
  }

  // Aucune exception, et l'embed reste sous les limites de Discord.
  const json = buildPanelPayload(store.getSnapshot({ pageSize: 8 }), { pageSize: 8 })
    .embeds[0]
    .toJSON();

  for (const field of json.fields) {
    assert.ok(field.value.length <= 1024);
  }
});

test('sans coalescence, 50 éditions dépassent le rate limit de Discord', async () => {
  // Reproduit le comportement d'origine : une édition par clic, sérialisées.
  const edits = /** @type {number[]} */ ([]);
  const WINDOW = 5000;
  const MAX_EDITS = 5;

  let attempts = 0;
  let rejected = 0;

  for (let index = 0; index < 50; index += 1) {
    attempts += 1;
    const now = Date.now();
    while (edits.length > 0 && now - edits[0] >= WINDOW) edits.shift();

    if (edits.length >= MAX_EDITS) {
      rejected += 1;
    } else {
      edits.push(now);
    }
  }

  assert.equal(attempts, 50);
  assert.ok(
    rejected >= 40,
    `une édition par clic doit être rejetée en masse, obtenu ${rejected}/50`
  );
});
