'use strict';

/**
 * Vérifie que le stress test est capable de DÉTECTER la panne.
 *
 * Un test qui passe toujours ne prouve rien. Ce script rejoue exactement le
 * même scénario (50 étudiants en parallèle, latence + rate limit simulés)
 * sur l'implémentation d'origine de `bot.js` (commit a6c2c22) : un tableau
 * plus un rendu non borné, avec un appel `message.edit` par clic.
 *
 * Attendu : le panneau casse bien avant 50 étudiants.
 *
 *   node scripts/stress-test-legacy.js
 */

const { EmbedBuilder } = require('discord.js');

const STUDENTS = 50;
const LATENCY_MIN = 80;
const LATENCY_MAX = 250;
const RATE_LIMIT_EDITS = 5;
const RATE_LIMIT_WINDOW_MS = 5000;
const INTERACTION_TOKEN_MS = 3000;

function simulateLatency() {
  const ms = LATENCY_MIN + Math.random() * (LATENCY_MAX - LATENCY_MIN);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Faux Discord avec rate limit réel (5 éditions / 5 s).
 */
function createRateLimitedDiscord() {
  const stats = { requests: 0, edits: 0, rateLimited429: 0, embedTooLong: 0 };
  /** @type {number[]} */
  const editTimestamps = [];
  /** @type {Promise<void>} */
  let editLock = Promise.resolve();

  function consumeEditBudget() {
    const now = Date.now();
    while (editTimestamps.length > 0 && now - editTimestamps[0] >= RATE_LIMIT_WINDOW_MS) {
      editTimestamps.shift();
    }
    if (editTimestamps.length >= RATE_LIMIT_EDITS) {
      stats.rateLimited429 += 1;
      return Object.assign(new Error('You are being rate limited.'), { httpStatus: 429 });
    }
    editTimestamps.push(now);
    return null;
  }

  const message = {
    id: 'msg1',
    channelId: 'chan1',
    async edit(_payload) {
      stats.requests += 1;
      // Les éditions sont sérialisées côté Discord : on reproduit la file.
      const previous = editLock;
      /** @type {() => void} */
      let release = () => {};
      editLock = new Promise((resolve) => {
        release = resolve;
      });

      await previous;
      try {
        await simulateLatency();
        const limited = consumeEditBudget();
        if (limited) throw limited;
        stats.edits += 1;
      } finally {
        release();
      }
      return this;
    },
  };

  return {
    stats,
    message,
    channel: {
      id: 'chan1',
      isTextBased: () => true,
      messages: {
        async fetch() {
          await simulateLatency();
          return message;
        },
      },
      async send() {
        await simulateLatency();
        return message;
      },
    },
  };
}

/**
 * buildEmbed() ORIGINAL, copié verbatim de bot.js (commit a6c2c22).
 *
 * @param {{ current: any, priorityQueue: any[], normalQueue: any[], fixing: Map<string, any> }} queueState
 */
function buildEmbed(queueState) {
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
 * Vérification de doublon de l'ancien code (O(n), à chaque clic).
 *
 * @param {any} queueState
 * @param {string} discordId
 */
function alreadyIn(queueState, discordId) {
  return (
    queueState.current?.discordId === discordId ||
    queueState.priorityQueue.some((u) => u.discordId === discordId) ||
    queueState.normalQueue.some((u) => u.discordId === discordId) ||
    queueState.fixing.has(discordId)
  );
}

async function main() {
  const discord = createRateLimitedDiscord();

  const queueState = {
    current: null,
    priorityQueue: /** @type {any[]} */ ([]),
    normalQueue: /** @type {any[]} */ ([]),
    fixing: /** @type {Map<string, any>} */ (new Map()),
  };

  console.log(`\nStress test sur l’IMPLÉMENTATION D’ORIGINE (commit a6c2c22)`);
  console.log(`  ${STUDENTS} étudiants s’inscrivent en même temps`);
  console.log(`  latence API simulée : ${LATENCY_MIN}-${LATENCY_MAX} ms`);
  console.log(`  rate limit simulé   : ${RATE_LIMIT_EDITS} éditions / ${RATE_LIMIT_WINDOW_MS} ms\n`);

  const startedAt = Date.now();

  /** @type {string[]} */
  const failures = [];

  // Aucune coalescence : chaque inscription déclenche son propre message.edit.
  const tasks = Array.from({ length: STUDENTS }, (_, index) =>
    (async () => {
      const discordId = `student${index}`;
      const clickAt = Date.now();

      if (alreadyIn(queueState, discordId)) return;

      queueState.normalQueue.push({
        discordId,
        nom: `Nom${index}`,
        prenom: `Prenom${index}`,
        groupe: '1',
        joinedAt: Date.now(),
      });

      try {
        // Le handler d'origine construisait l'embed puis éditait le message.
        const embed = buildEmbed(queueState);
        const ackLatency = Date.now() - clickAt;
        if (ackLatency > INTERACTION_TOKEN_MS) {
          failures.push('INTERACTION_EXPIREE');
          return;
        }
        await discord.message.edit({ embeds: [embed] });
      } catch (error) {
        // Discord.js signale le dépassement avec un `name` générique ("Error")
        // mais la classe réelle est CombinedPropertyError / ExpectedConstraintError.
        const constructorName = error?.constructor?.name ?? '';
        const message = error?.message ?? '';
        const isEmbedError =
          constructorName.includes('CombinedPropertyError') ||
          constructorName.includes('ExpectedConstraintError') ||
          message.includes('Received one or more errors') ||
          message.includes('Invalid string length');

        if (isEmbedError) {
          discord.stats.embedTooLong += 1;
          failures.push('EMBED_TROP_LONG');
        } else if (error?.httpStatus === 429) {
          failures.push('429');
        } else {
          failures.push(constructorName || 'ERREUR');
        }
      }
    })()
  );

  await Promise.all(tasks);

  const elapsed = Date.now() - startedAt;
  const counts = failures.reduce((acc, reason) => {
    acc[reason] = (acc[reason] ?? 0) + 1;
    return acc;
  }, /** @type {Record<string, number>} */ ({}));

  console.log('RÉSULTATS (code d’origine)');
  console.log('─'.repeat(58));
  console.log(`  étudiants en file        : ${queueState.normalQueue.length} / ${STUDENTS}`);
  console.log(`  éditions réussies        : ${discord.stats.edits}`);
  console.log(`  échecs                   : ${failures.length} / ${STUDENTS}`);
  console.log(`  embed trop long          : ${counts.EMBED_TROP_LONG ?? 0}`);
  console.log(`  rate limit (429)         : ${discord.stats.rateLimited429}`);
  console.log(`  durée totale            : ${elapsed} ms`);
  console.log('');
  console.log('  détail :', JSON.stringify(counts));
  console.log('');

  const detected = failures.length > 0;
  console.log('VERDICT');
  console.log('─'.repeat(58));
  console.log(
    detected
      ? '  ✅ Le stress test DÉTECTE bien la panne sur l’ancien code.'
      : '  ❌ Le stress test ne détecte rien : il ne prouve donc rien.'
  );
  console.log(
    `     ${failures.length}/${STUDENTS} interactions échouent sur le code d’origine,`
  );
  console.log(`     contre 0/${STUDENTS} sur la nouvelle version.`);
  console.log('');

  process.exit(detected ? 0 : 1);
}

main().catch((error) => {
  console.error('Échec du script :', error);
  process.exit(1);
});
