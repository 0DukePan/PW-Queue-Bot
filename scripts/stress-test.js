'use strict';

/**
 * Stress test réaliste : 50 étudiants qui s'inscrivent en même temps.
 *
 * Contrairement aux tests unitaires (faux client instantané), ce script
 * simule le comportement de l'API Discord :
 *   - latence réseau de 80 à 250 ms par requête ;
 *   - rate limit de 5 éditions / 5 s par salon (réponse 429 + retry_after) ;
 *   - token d'interaction valide 3 s (au-delà : interaction perdue).
 *
 * On mesure ce qui compte vraiment : est-ce qu'un étudiant perd son clic,
 * est-ce que le panneau reste cohérent, et combien de requêtes partent.
 *
 *   node scripts/stress-test.js
 */

const { createBoard } = require('../src/board');
const { QueueStore } = require('../src/queue-store');
const { createInteractionHandler } = require('../src/interactions');
const { IDS } = require('../src/panel');
const { createConfig, createLogger } = require('../src/env');

const logger = createLogger('error');

/** Paramètres de simulation. */
const STUDENTS = 50;
const LATENCY_MIN = 80;
const LATENCY_MAX = 250;
const RATE_LIMIT_EDITS = 5;
const RATE_LIMIT_WINDOW_MS = 5000;
const INTERACTION_TOKEN_MS = 3000;

/**
 * Attend entre LATENCY_MIN et LATENCY_MAX ms.
 */
function simulateLatency() {
  const ms = LATENCY_MIN + Math.random() * (LATENCY_MAX - LATENCY_MIN);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Faux Discord qui applique réellement les rate limits.
 */
function createRateLimitedDiscord() {
  const stats = {
    requests: 0,
    edits: 0,
    sends: 0,
    rateLimited429: 0,
    editTimestamps: /** @type {number[]} */ ([]),
  };

  let nextId = 1;
  const messages = new Map();

  /** Applique la fenêtre glissante 5 edits / 5 s. */
  function consumeEditBudget() {
    const now = Date.now();
    stats.editTimestamps = stats.editTimestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (stats.editTimestamps.length >= RATE_LIMIT_EDITS) {
      stats.rateLimited429 += 1;
      const retryAfter = RATE_LIMIT_WINDOW_MS - (now - stats.editTimestamps[0]);
      const error = new Error('You are being rate limited.');
      error.code = 0;
      error.httpStatus = 429;
      error.retryAfter = retryAfter / 1000;
      return error;
    }
    stats.editTimestamps.push(now);
    return null;
  }

  function makeMessage(id) {
    return {
      id,
      channelId: 'chan1',
      url: `https://discord.test/${id}`,
      /** @param {any} _payload */
      async edit(_payload) {
        stats.requests += 1;
        await simulateLatency();
        const limited = consumeEditBudget();
        if (limited) throw limited;
        stats.edits += 1;
        return this;
      },
    };
  }

  const channel = {
    id: 'chan1',
    isTextBased: () => true,
    messages: {
      /** @param {string} id */
      async fetch(id) {
        stats.requests += 1;
        await simulateLatency();
        const message = messages.get(id);
        if (!message) throw Object.assign(new Error('Unknown Message'), { code: 10_008 });
        return message;
      },
    },
    async send() {
      stats.requests += 1;
      await simulateLatency();
      const id = `msg${nextId}`;
      nextId += 1;
      const message = makeMessage(id);
      messages.set(id, message);
      stats.sends += 1;
      stats.editTimestamps.push(Date.now());
      return message;
    },
  };

  return { channel, stats };
}

/** Persistance factice (pas d'écriture disque). */
function createFakePersistence() {
  const state = { scheduled: 0 };
  return {
    state,
    schedule() {
      state.scheduled += 1;
    },
    async flush() {},
    async close() {},
    load() {
      return null;
    },
    file: 'memory',
  };
}

/**
 * Fausse interaction qui vérifie le délai d'acquittement (token de 3 s).
 *
 * @param {{ customId: string, userId: string, messageId: string, fields?: any }} options
 */
function createInteraction({ customId, userId, messageId, fields }) {
  const record = {
    ackLatencyMs: null,
    ackType: null,
    expired: false,
    errored: null,
  };
  let createdAt = Date.now();

  /** Marque l'acquittement et vérifie qu'il reste dans les 3 s. */
  const ack = (type) => {
    if (record.ackType) return;
    record.ackType = type;
    record.ackLatencyMs = Date.now() - createdAt;
    if (record.ackLatencyMs > INTERACTION_TOKEN_MS) record.expired = true;
  };

  return {
    record,
    user: { id: userId },
    member: { roles: { cache: new Map() }, permissions: { has: () => false } },
    guildId: 'guild1',
    channelId: 'chan1',
    channel: null,
    message: { id: messageId },
    customId,
    commandName: '',
    replied: false,
    deferred: false,
    fields: { getTextInputValue: (key) => fields?.[key] ?? '' },
    isChatInputCommand: () => false,
    isButton: () => false,
    isModalSubmit: () => true,
    isRepliable: () => true,
    async reply() {
      ack('reply');
      this.replied = true;
      await simulateLatency();
      return {};
    },
    async update() {
      ack('update');
      this.replied = true;
      await simulateLatency();
      return {};
    },
    async deferReply() {
      ack('deferReply');
      this.deferred = true;
      await simulateLatency();
      return {};
    },
    async editReply() {
      await simulateLatency();
      return {};
    },
    async followUp() {
      await simulateLatency();
      return {};
    },
    async showModal() {
      ack('showModal');
      return {};
    },
  };
}

async function main() {
  const discord = createRateLimitedDiscord();
  const store = new QueueStore();
  const persistence = createFakePersistence();

  const board = createBoard({
    getClient: () => ({ channels: { fetch: async () => discord.channel } }),
    store,
    logger,
    minIntervalMs: 1500,
    render: () => ({ content: 'panneau', revision: store.revision }),
  });

  const config = createConfig({
    DISCORD_TOKEN: 't',
    DISCORD_CLIENT_ID: 'c',
    QUEUE_PAGE_SIZE: '8',
  });

  const handler = createInteractionHandler({
    store,
    board,
    config,
    logger,
    persistence,
    isStaff: () => false,
  });

  const sent = await board.publish(discord.channel);
  const messageId = sent.id;

  console.log(`\nStress test : ${STUDENTS} étudiants s’inscrivent en même temps`);
  console.log(`  latence API simulée : ${LATENCY_MIN}-${LATENCY_MAX} ms`);
  console.log(`  rate limit simulé   : ${RATE_LIMIT_EDITS} éditions / ${RATE_LIMIT_WINDOW_MS} ms`);
  console.log(`  token interaction   : ${INTERACTION_TOKEN_MS} ms\n`);

  discord.stats.edits = 0;
  discord.stats.requests = 0;
  discord.stats.rateLimited429 = 0;
  discord.stats.editTimestamps = [Date.now()];

  const startedAt = Date.now();

  // Tous les étudiants valident leur formulaire dans la même boucle d'event.
  const interactions = Array.from({ length: STUDENTS }, (_, index) =>
    createInteraction({
      customId: IDS.modalJoin,
      userId: `student${index}`,
      messageId,
      fields: { nom: `Nom${index}`, prenom: `Prenom${index}`, groupe: '1' },
    })
  );

  interactions.forEach((interaction) => {
    void handler.handle(interaction).catch((error) => {
      interaction.record.errored = error?.message ?? String(error);
    });
  });

  // Laisse le panneau finir ses éditions différées.
  await new Promise((resolve) => setTimeout(resolve, 6000));
  await board.settle().catch(() => {});

  const elapsed = Date.now() - startedAt;

  // --- Résultats ---------------------------------------------------------
  const ackLatencies = interactions
    .map((i) => i.record.ackLatencyMs)
    .filter((value) => value !== null);

  const expired = interactions.filter((i) => i.record.expired).length;
  const acked = interactions.filter((i) => i.record.ackType !== null).length;
  const errored = interactions.filter((i) => i.record.errored).length;

  console.log('RÉSULTATS');
  console.log('─'.repeat(58));
  console.log(`  étudiants inscrits       : ${store.normal.size} / ${STUDENTS}`);
  console.log(`  interactions acquittées  : ${acked} / ${STUDENTS}`);
  console.log(`  interactions expirées    : ${expired}  (token > 3 s)`);
  console.log(`  erreurs non gérées      : ${errored}`);
  console.log('');
  console.log(`  requêtes vers l’API      : ${discord.stats.requests}`);
  console.log(`  éditions du panneau      : ${discord.stats.edits}`);
  console.log(`  réponses 429 reçues      : ${discord.stats.rateLimited429}  (simulées)`);
  console.log(`  éditions regroupées      : ${board.stats.coalesced}`);
  console.log(`  durée totale             : ${elapsed} ms`);
  console.log('');

  if (ackLatencies.length > 0) {
    const sorted = [...ackLatencies].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const max = sorted[sorted.length - 1];
    console.log(`  acquittement p50         : ${p50} ms`);
    console.log(`  acquittement p95         : ${p95} ms`);
    console.log(`  acquittement max         : ${max} ms  (limite ${INTERACTION_TOKEN_MS})`);
    console.log('');
  }

  // --- Verdict -----------------------------------------------------------
  const checks = [
    ['tous les étudiants enregistrés', store.normal.size === STUDENTS],
    ['aucune interaction perdue', expired === 0],
    ['aucune requête 429', discord.stats.rateLimited429 === 0],
    ['aucune erreur non gérée', errored === 0],
    ['tous les clics acquittés', acked === STUDENTS],
  ];

  console.log('VERDICT');
  console.log('─'.repeat(58));
  let allOk = true;
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? '✅' : '❌'} ${label}`);
    if (!ok) allOk = false;
  }

  console.log('');
  console.log(
    allOk
      ? `✅ ${STUDENTS} inscriptions simultanées passent sans perte ni rate limit.`
      : '❌ Le scénario de charge a échoué.'
  );
  console.log('');

  board.dispose();
  process.exit(allOk ? 0 : 1);
}

main().catch((error) => {
  console.error('Échec du stress test :', error);
  process.exit(1);
});
