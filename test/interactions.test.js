'use strict';

/**
 * Tests du gestionnaire d'interactions.
 *
 * On simule de vraies interactions Discord (avec un faux client) pour vérifier
 * le comportement qui compte en TP :
 *  - une classe entière qui s'inscrit en rafale ne produit qu'une édition ;
 *  - un clic espacé profite de `interaction.update` (1 seule requête) ;
 *  - les erreurs métier restent éphémères et ne cassent pas le panneau ;
 *  - les boutons d'un panneau obsolète sont ignorés.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createBoard } = require('../src/board');
const { QueueStore } = require('../src/queue-store');
const { createInteractionHandler } = require('../src/interactions');
const { IDS } = require('../src/panel');
const { createConfig, createLogger } = require('../src/env');

const silentLogger = createLogger('error');

/** Faux salon qui compte les éditions. */
function createFakeChannel() {
  const state = { sends: 0, edits: 0, updates: 0, nextId: 1 };
  const messages = new Map();

  /** @param {string} id */
  const makeMessage = (id) => ({
    id,
    channelId: 'chan1',
    url: `https://discord.test/${id}`,
    async edit() {
      state.edits += 1;
      return this;
    },
  });

  return {
    state,
    messages,
    channel: {
      id: 'chan1',
      isTextBased: () => true,
      messages: {
        /** @param {string} id */
        async fetch(id) {
          const message = messages.get(id);
          if (!message) throw Object.assign(new Error('Unknown Message'), { code: 10_008 });
          return message;
        },
      },
      async send() {
        state.sends += 1;
        const id = `msg${state.nextId}`;
        state.nextId += 1;
        const message = makeMessage(id);
        messages.set(id, message);
        return message;
      },
    },
  };
}

/**
 * Faux gestionnaire de persistance (aucune écriture disque en test).
 */
function createFakePersistence() {
  const state = { scheduled: 0, flushed: 0 };
  return {
    state,
    schedule() {
      state.scheduled += 1;
    },
    async flush() {
      state.flushed += 1;
    },
    async close() {},
    load() {
      return null;
    },
    file: 'memory',
  };
}

/**
 * Fausse interaction.
 *
 * @param {{
 *   type?: 'button' | 'modal' | 'command',
 *   customId?: string,
 *   commandName?: string,
 *   userId?: string,
 *   messageId?: string,
 *   isStaff?: boolean,
 *   fields?: Record<string, string>,
 *   channel?: any,
 * }} [options]
 */
function createFakeInteraction(options = {}) {
  const {
    type = 'button',
    customId = '',
    commandName = '',
    userId = 'user1',
    messageId = 'msg1',
    isStaff = false,
    fields = {},
    channel = {
      id: 'chan1',
      isTextBased: () => true,
      messages: {
        async fetch() {
          throw Object.assign(new Error('Unknown Message'), { code: 10_008 });
        },
      },
      async send() {
        return { id: `anon${Math.random().toString(36).slice(2)}`, url: 'https://discord.test/x' };
      },
    },
  } = options;

  const calls = {
    reply: /** @type {any[]} */ ([]),
    update: /** @type {any[]} */ ([]),
    editReply: /** @type {any[]} */ ([]),
    followUp: /** @type {any[]} */ ([]),
    deferReply: 0,
    showModal: 0,
  };

  const interaction = {
    calls,
    user: { id: userId },
    member: isStaff
      ? { roles: { cache: new Map([['r1', { id: 'r1', name: 'Prof' }]]) }, permissions: { has: () => false } }
      : { roles: { cache: new Map() }, permissions: { has: () => false } },
    guildId: 'guild1',
    channelId: 'chan1',
    channel,
    message: { id: messageId },
    customId,
    commandName,
    replied: false,
    deferred: false,
    fields: { getTextInputValue: (key) => fields[key] },
    isChatInputCommand: () => type === 'command',
    isButton: () => type === 'button',
    isModalSubmit: () => type === 'modal',
    isRepliable: () => true,
    async reply(payload) {
      calls.reply.push(payload);
      this.replied = true;
      return payload;
    },
    async update(payload) {
      calls.update.push(payload);
      this.replied = true;
      return payload;
    },
    async deferReply(payload) {
      calls.deferReply += 1;
      this.deferred = true;
      return payload;
    },
    async editReply(payload) {
      calls.editReply.push(payload);
      return payload;
    },
    async followUp(payload) {
      calls.followUp.push(payload);
      return payload;
    },
    async showModal() {
      calls.showModal += 1;
      return undefined;
    },
  };

  return interaction;
}

/** Construit le trio handler/store/board sur un faux salon. */
async function setup({ minIntervalMs = 20, pageSize = 8 } = {}) {
  const fake = createFakeChannel();
  const store = new QueueStore();
  const persistence = createFakePersistence();

  const board = createBoard({
    getClient: () => ({ channels: { fetch: async () => fake.channel } }),
    store,
    logger: silentLogger,
    minIntervalMs,
    render: () => ({ content: 'panneau', revision: store.revision }),
  });

  const config = createConfig({ DISCORD_TOKEN: 't', DISCORD_CLIENT_ID: 'c', QUEUE_PAGE_SIZE: String(pageSize) });

  const handler = createInteractionHandler({
    store,
    board,
    config,
    logger: silentLogger,
    persistence,
    isStaff: (member) => (member?.roles?.cache?.size ?? 0) > 0,
  });

  const sent = await board.publish(fake.channel);
  return { fake, store, board, handler, persistence, messageId: sent.id };
}

const STUDENT_FIELDS = { nom: 'Doe', prenom: 'Jane', groupe: '2' };

test('/tp-start est refusé hors staff', async () => {
  const { handler } = await setup();
  const interaction = createFakeInteraction({ type: 'command', commandName: 'tp-start' });

  await handler.handle(interaction);

  assert.equal(interaction.calls.reply.length, 1);
  assert.match(interaction.calls.reply[0].content, /Réservé/);
});

test('/tp-start publie un panneau et réinitialise la file', async () => {
  const { handler, store, fake } = await setup();
  store.join({ discordId: 'x', nom: 'A', prenom: 'B', groupe: '1' });

  const interaction = createFakeInteraction({
    type: 'command',
    commandName: 'tp-start',
    isStaff: true,
  });
  await handler.handle(interaction);
  assert.equal(store.size, 0, 'la file doit être remise à zéro');
  assert.equal(interaction.calls.deferReply, 1, 'acquittement immédiat');
  assert.match(interaction.calls.editReply[0].content, /File relancée/);
  assert.ok(fake.state.sends >= 1);
});

test('le bouton Rejoindre ouvre un formulaire sans requête supplémentaire', async () => {
  const { handler, messageId } = await setup();
  const interaction = createFakeInteraction({ customId: IDS.join, messageId });

  await handler.handle(interaction);

  assert.equal(interaction.calls.showModal, 1);
  assert.equal(interaction.calls.reply.length, 0);
});

test('une rafale d’inscriptions ne produit qu’une édition du panneau', async () => {
  const { handler, store, fake, messageId } = await setup({ minIntervalMs: 30 });

  const before = fake.state.edits;

  // 30 étudiants valident leur formulaire en même temps.
  for (let index = 0; index < 30; index += 1) {
    const interaction = createFakeInteraction({
      type: 'modal',
      customId: IDS.modalJoin,
      userId: `student${index}`,
      fields: STUDENT_FIELDS,
    });
    // eslint-disable-next-line no-await-in-loop
    await handler.handle(interaction);
    assert.match(interaction.calls.reply[0].content, /Inscription validée/);
  }

  assert.equal(store.normal.size, 30);

  // Le panneau est rafraîchi en arrière-plan : on laisse la boucle se vider.
  await new Promise((resolve) => setTimeout(resolve, 80));
  const edits = fake.state.edits - before;

  assert.ok(edits >= 1, 'le panneau doit être mis à jour au moins une fois');
  assert.ok(edits <= 3, `30 inscriptions doivent tenir en <= 3 éditions, obtenu ${edits}`);
  assert.equal(messageId, messageId);
});

test('un clic espacé utilise interaction.update (une seule requête)', async () => {
  const { handler, store, messageId } = await setup({ minIntervalMs: 0 });

  store.join({ discordId: 'student', nom: 'Doe', prenom: 'Jane', groupe: '1' });

  const interaction = createFakeInteraction({
    customId: IDS.next,
    messageId,
    isStaff: true,
  });
  await handler.handle(interaction);

  assert.equal(interaction.calls.update.length, 1, 'mise à jour directe du panneau');
  assert.equal(interaction.calls.deferReply, 0, 'aucun acquittement nécessaire');
  assert.equal(store.current?.discordId, 'student');
});

test('un clic rapproché bascule sur l’acquittement éphémère', async () => {
  const { handler, store, messageId } = await setup({ minIntervalMs: 5_000 });
  store.join({ discordId: 'student', nom: 'Doe', prenom: 'Jane', groupe: '1' });

  const interaction = createFakeInteraction({ customId: IDS.next, messageId, isStaff: true });
  await handler.handle(interaction);

  assert.equal(interaction.calls.update.length, 0);
  assert.equal(interaction.calls.deferReply, 1);
  assert.match(interaction.calls.editReply[0].content, /Au tour de/);
  assert.equal(store.current?.discordId, 'student');
});

test('quitter la file quand on n’est pas inscrit reste éphémère', async () => {
  const { handler, messageId } = await setup();
  const interaction = createFakeInteraction({ customId: IDS.leave, messageId });

  await handler.handle(interaction);

  assert.match(interaction.calls.reply[0].content, /n’étais pas/);
  assert.equal(interaction.calls.update.length, 0);
});

test('un panneau obsolète ne peut plus piloter la file', async () => {
  const { handler, store } = await setup();

  const interaction = createFakeInteraction({ customId: IDS.next, messageId: 'vieux-message', isStaff: true });
  await handler.handle(interaction);

  assert.match(interaction.calls.reply[0].content, /obsolète/);
  assert.equal(store.current, null);
});

test('un étudiant déjà inscrit reçoit un message clair', async () => {
  const { handler, store, messageId } = await setup();
  store.join({ discordId: 'user1', nom: 'Doe', prenom: 'Jane', groupe: '1' });

  const interaction = createFakeInteraction({ customId: IDS.join, messageId });
  await handler.handle(interaction);

  assert.equal(interaction.calls.showModal, 0);
  assert.match(interaction.calls.reply[0].content, /déjà inscrit/);
});

test('une inscription invalide ne modifie pas la file', async () => {
  const { handler, store } = await setup();

  const interaction = createFakeInteraction({
    type: 'modal',
    customId: IDS.modalJoin,
    fields: { nom: 'Doe', prenom: 'Jane', groupe: '9' },
  });
  await handler.handle(interaction);

  assert.equal(store.size, 0);
  assert.match(interaction.calls.reply[0].content, /Groupe invalide/);
});

test('une exception inattendue renvoie une erreur éphémère', async () => {
  const { handler } = await setup();

  const interaction = createFakeInteraction({ customId: 'inconnu', messageId: 'msg1' });
  interaction.channel = null;
  interaction.isButton = () => {
    throw new Error('boom');
  };

  await handler.handle(interaction);

  assert.equal(interaction.calls.reply.length, 1);
  assert.match(interaction.calls.reply[0].content, /erreur interne/);
});
