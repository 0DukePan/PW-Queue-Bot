'use strict';

/**
 * Tests de charge : vérifient que le bot tient quand la file se remplit vite.
 *
 * Ce sont des tests *de comportement sous rafale*, avec latence et rate limit
 * simulés, et non des tests unitaires isolés. Ils répondent à une seule
 * question : est-ce qu'un étudiant perd son clic quand 50 personnes s'inscrivent
 * en même temps ?
 *
 * Le pendant négatif existe : `test/stress-legacy.test.js` rejoue le même
 * scénario sur le code d'origine pour prouver que ces tests savent échouer.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createBoard } = require('../src/board');
const { QueueStore } = require('../src/queue-store');
const { createInteractionHandler } = require('../src/interactions');
const { IDS } = require('../src/panel');
const { createConfig, createLogger } = require('../src/env');

const silentLogger = createLogger('error');

/** Latence réseau simulée (ms). */
const LATENCY_MIN = 80;
const LATENCY_MAX = 250;
/** Limite Discord réelle : 5 éditions par 5 s et par salon. */
const RATE_LIMIT_EDITS = 5;
const RATE_LIMIT_WINDOW_MS = 5000;
/** Un token d'interaction est valide 3 s. */
const INTERACTION_TOKEN_MS = 3000;

function simulateLatency() {
  const ms = LATENCY_MIN + Math.random() * (LATENCY_MAX - LATENCY_MIN);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Faux Discord qui applique réellement le rate limit par salon.
 */
function createRateLimitedDiscord() {
  const stats = {
    requests: 0,
    edits: 0,
    sends: 0,
    rateLimited429: 0,
    /** @type {number[]} */
    editTimestamps: [],
  };

  let nextId = 1;
  const messages = new Map();

  function consumeEditBudget() {
    const now = Date.now();
    while (stats.editTimestamps.length > 0 && now - stats.editTimestamps[0] >= RATE_LIMIT_WINDOW_MS) {
      stats.editTimestamps.shift();
    }
    if (stats.editTimestamps.length >= RATE_LIMIT_EDITS) {
      stats.rateLimited429 += 1;
      return Object.assign(new Error('You are being rate limited.'), {
        httpStatus: 429,
        code: 0,
      });
    }
    stats.editTimestamps.push(now);
    return null;
  }

  /** @param {string} id */
  function makeMessage(id) {
    return {
      id,
      channelId: 'chan1',
      url: `https://discord.test/${id}`,
      async edit() {
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

function createFakePersistence() {
  return {
    schedule() {},
    async flush() {},
    async close() {},
    load() {
      return null;
    },
    file: 'memory',
  };
}

/**
 * Fausse interaction qui mesure son délai d'acquittement.
 *
 * @param {{ userId: string, fields?: Record<string, string> }} options
 */
function createJoinInteraction({ userId, fields }) {
  const record = { ackType: null, ackLatencyMs: null, errored: null };
  const clickAt = Date.now();

  const ack = (type) => {
    if (record.ackType) return;
    record.ackType = type;
    record.ackLatencyMs = Date.now() - clickAt;
  };

  return {
    record,
    user: { id: userId },
    member: { roles: { cache: new Map() }, permissions: { has: () => false } },
    guildId: 'guild1',
    channelId: 'chan1',
    channel: null,
    message: { id: 'msg1' },
    customId: IDS.modalJoin,
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
    async deferReply() {
      ack('deferReply');
      this.deferred = true;
      await simulateLatency();
      return {};
    },
    async update() {
      ack('update');
      this.replied = true;
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

/** Prépare le trio handler / store / board sur un faux Discord limité. */
async function setup() {
  const discord = createRateLimitedDiscord();
  const store = new QueueStore();

  const board = createBoard({
    getClient: () => ({ channels: { fetch: async () => discord.channel } }),
    store,
    logger: silentLogger,
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
    logger: silentLogger,
    persistence: createFakePersistence(),
    isStaff: () => false,
  });

  const sent = await board.publish(discord.channel);
  discord.stats.edits = 0;
  discord.stats.requests = 0;
  discord.stats.rateLimited429 = 0;
  discord.stats.editTimestamps = [Date.now()];

  return { discord, store, board, handler, messageId: sent.id };
}

/**
 * Lance `count` inscriptions strictement en parallèle.
 *
 * @param {{ handler: any, count: number }} options
 */
async function burst({ handler, count }) {
  const interactions = Array.from({ length: count }, (_, index) =>
    createJoinInteraction({
      userId: `student${index}`,
      fields: { nom: `Nom${index}`, prenom: `Prenom${index}`, groupe: '1' },
    })
  );

  await Promise.all(
    interactions.map((interaction) =>
      handler.handle(interaction).catch((error) => {
        interaction.record.errored = error?.message ?? String(error);
      })
    )
  );

  return interactions;
}

test('50 inscriptions simultanées : aucune perte, aucun 429', async () => {
  const { discord, store, board, handler } = await setup();

  const interactions = await burst({ handler, count: 50 });
  await board.settle().catch(() => {});

  // Toutes les inscriptions comptent.
  assert.equal(store.normal.size, 50, 'les 50 étudiants doivent être enregistrés');

  // Aucune interaction perdue : chacune a été acquittée.
  const acked = interactions.filter((i) => i.record.ackType !== null);
  assert.equal(acked.length, 50, 'chaque clic doit recevoir une réponse');

  // Aucune n'a dépassé les 3 s du token d'interaction.
  const expired = interactions.filter((i) => i.record.ackLatencyMs > INTERACTION_TOKEN_MS);
  assert.equal(expired.length, 0, 'aucune interaction ne doit expirer');

  // Aucune erreur non gérée.
  assert.equal(interactions.filter((i) => i.record.errored).length, 0);

  // Le rate limit n'a jamais été atteint.
  assert.equal(discord.stats.rateLimited429, 0, 'aucun 429 ne doit survenir');

  board.dispose();
});

test('50 inscriptions simultanées : le panneau est édité très peu de fois', async () => {
  const { discord, store, board, handler } = await setup();

  await burst({ handler, count: 50 });
  await board.settle().catch(() => {});

  assert.equal(store.normal.size, 50);
  // Sans coalescence il faudrait 50 éditions ; la limite Discord en autorise
  // 5 par 5 s. On doit donc rester très en dessous.
  assert.ok(
    discord.stats.edits <= 3,
    `50 inscriptions doivent tenir en <= 3 éditions, obtenu ${discord.stats.edits}`
  );

  board.dispose();
});

test('une rafale de 120 inscriptions tient aussi', async () => {
  const { discord, store, board, handler } = await setup();

  await burst({ handler, count: 120 });
  await board.settle().catch(() => {});

  assert.equal(store.normal.size, 120);
  assert.equal(discord.stats.rateLimited429, 0, 'aucun 429 même à 120 inscrits');

  board.dispose();
});

test('le panneau reste valide pour Discord à 200 inscrits', async () => {
  const { buildPanelPayload } = require('../src/panel');
  const store = new QueueStore({ maxQueueLength: 1000 });

  for (let index = 0; index < 200; index += 1) {
    store.join({
      discordId: `u${index}`,
      nom: 'Boumediene',
      prenom: 'Abdelkader',
      groupe: '1',
    });
  }

  // La vraie EmbedBuilder valide les contraintes de Discord (1024 par champ).
  const payload = buildPanelPayload(store.getSnapshot({ pageSize: 8 }), { pageSize: 8 });
  const json = payload.embeds[0].toJSON();

  for (const field of json.fields) {
    assert.ok(
      field.value.length <= 1024,
      `champ "${field.name}" trop long : ${field.value.length}`
    );
  }
});
