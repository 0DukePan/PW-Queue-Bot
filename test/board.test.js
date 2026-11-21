'use strict';

/**
 * Tests du panneau : coalescence des éditions, repli après suppression du
 * message, détection de panneau obsolète.
 *
 * Un faux client Discord suffit : `board` ne dépend que de trois méthodes
 * (`channels.fetch`, `messages.fetch`, `send`/`edit`), ce qui rend le
 * comportement anti-rate-limit vérifiable sans réseau.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createBoard } = require('../src/board');
const { QueueStore } = require('../src/queue-store');
const { createLogger } = require('../src/env');

const silentLogger = createLogger('error');

/**
 * Faux salon : compte les éditions et peut simuler un message supprimé.
 *
 * @param {{ failWith?: any }} [options]
 */
function createFakeChannel(options = {}) {
  const state = {
    sends: 0,
    edits: 0,
    payloads: /** @type {any[]} */ ([]),
    failWith: options.failWith ?? null,
    nextMessageId: 1,
    deleted: new Set(),
  };

  /** @param {string} id */
  const makeMessage = (id) => ({
    id,
    channelId: 'chan1',
    url: `https://discord.test/${id}`,
    async edit(payload) {
      if (state.failWith) throw state.failWith;
      // Comme l'API réelle : éditer un message supprimé échoue en 10008.
      if (state.deleted.has(id)) {
        throw Object.assign(new Error('Unknown Message'), { code: 10_008 });
      }
      state.edits += 1;
      state.payloads.push(payload);
      return this;
    },
  });

  /** @type {Record<string, any>} */
  const messages = new Map();

  const channel = {
    id: 'chan1',
    isTextBased: () => true,
    messages: {
      /** @param {string} id */
      async fetch(id) {
        if (state.deleted.has(id)) {
          throw Object.assign(new Error('Unknown Message'), { code: 10_008 });
        }
        const message = messages.get(id);
        if (!message) throw Object.assign(new Error('Unknown Message'), { code: 10_008 });
        return message;
      },
    },
    /** @param {any} _payload */
    async send(_payload) {
      state.sends += 1;
      const id = `msg${state.nextMessageId}`;
      state.nextMessageId += 1;
      const message = makeMessage(id);
      messages.set(id, message);
      return message;
    },
  };

  return { channel, state, messages };
}

/**
 * @param {ReturnType<typeof createFakeChannel>} fake
 */
function createFakeClient(fake) {
  return {
    channels: {
      /** @param {string} _id */
      async fetch(_id) {
        return fake.channel;
      },
    },
  };
}

function makeBoard({ store, fake, minIntervalMs = 20 }) {
  return createBoard({
    getClient: () => createFakeClient(fake),
    store,
    logger: silentLogger,
    minIntervalMs,
    render: () => ({ content: 'panneau', revision: store.revision }),
  });
}

test('publish envoie une fois et retient le panneau', async () => {
  const fake = createFakeChannel();
  const store = new QueueStore();
  const board = makeBoard({ store, fake });

  const sent = await board.publish(fake.channel);

  assert.equal(fake.state.sends, 1);
  assert.deepEqual(board.board, { channelId: 'chan1', messageId: sent.id });
  assert.equal(board.isCurrentMessage(sent.id), true);
  assert.equal(board.isCurrentMessage('autre'), false);
  board.dispose();
});

test('une rafale d invalidations ne produit qu’une seule édition', async () => {
  const fake = createFakeChannel();
  const store = new QueueStore();
  const board = makeBoard({ store, fake });

  await board.publish(fake.channel);
  fake.state.edits = 0;

  // 25 inscriptions d'affilée : c'est le pic qui saturait le bot d'origine.
  for (let index = 0; index < 25; index += 1) {
    store.join({ discordId: `u${index}`, nom: 'N', prenom: 'P', groupe: '1' });
    board.invalidate();
  }

  await board.settle();

  assert.equal(fake.state.edits, 1, 'les 25 clics doivent tenir en une édition');
  assert.ok(board.stats.coalesced >= 20, `coalesced=${board.stats.coalesced}`);
  board.dispose();
});

test('markSynced évite une édition redondante (mode interaction.update)', async () => {
  const fake = createFakeChannel();
  const store = new QueueStore();
  const board = makeBoard({ store, fake });

  await board.publish(fake.channel);
  fake.state.edits = 0;

  store.join({ discordId: 'a', nom: 'N', prenom: 'P', groupe: '1' });
  // Une interaction a déjà édité le panneau avec ce rendu.
  board.markSynced(store.revision);

  await board.settle();
  assert.equal(fake.state.edits, 0, 'aucune édition supplémentaire nécessaire');
  board.dispose();
});

test('canEditDirectly autorise les clics espacés, pas les rafales', async () => {
  const fake = createFakeChannel();
  const store = new QueueStore();
  const board = makeBoard({ store, fake, minIntervalMs: 30 });

  await board.publish(fake.channel);
  assert.equal(board.canEditDirectly(), false, 'juste après une édition : trop tôt');

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(board.canEditDirectly(), true, 'après l’intervalle : édition directe OK');

  store.join({ discordId: 'a', nom: 'N', prenom: 'P', groupe: '1' });
  board.invalidate();
  assert.equal(board.canEditDirectly(), false, 'une édition est déjà programmée');
  board.dispose();
});

test('un panneau supprimé est republié automatiquement', async () => {
  const fake = createFakeChannel();
  const store = new QueueStore();
  const board = makeBoard({ store, fake });

  const sent = await board.publish(fake.channel);
  fake.state.deleted.add(sent.id);
  fake.state.edits = 0;

  store.join({ discordId: 'a', nom: 'N', prenom: 'P', groupe: '1' });
  board.invalidate();
  await board.settle();

  assert.equal(fake.state.sends, 2, 'le panneau doit être republié');
  assert.notEqual(board.board?.messageId, sent.id);
  assert.equal(board.stats.reposts, 1);
  board.dispose();
});

test('restore réédite le panneau sauvegardé', async () => {
  const fake = createFakeChannel();
  const store = new QueueStore();
  const board = makeBoard({ store, fake });

  const sent = await board.publish(fake.channel);
  fake.state.edits = 0;

  const other = makeBoard({ store, fake });
  const ok = await other.restore({ channelId: 'chan1', messageId: sent.id });

  assert.equal(ok, true);
  assert.equal(fake.state.edits, 1);
  other.dispose();
  board.dispose();
});

test('restore renvoie false si le message a disparu', async () => {
  const fake = createFakeChannel();
  const store = new QueueStore();
  const board = makeBoard({ store, fake });

  const ok = await board.restore({ channelId: 'chan1', messageId: 'disparu' });

  assert.equal(ok, false);
  assert.equal(board.board, null);
  board.dispose();
});
