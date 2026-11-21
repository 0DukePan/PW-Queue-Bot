'use strict';

/**
 * Assemblage de l'application.
 *
 * `createBot()` ne fait aucune I/O : il construit le client, la file et le
 * panneau, puis branche les écouteurs. C'est ce qui rend le démarrage
 * testable et `bot.js` trivial.
 */

const { Client, GatewayIntentBits, Events, REST } = require('discord.js');

const { createPersistence } = require('./persistence');
const { createBoard } = require('./board');
const { QueueStore } = require('./queue-store');
const { buildPanelPayload } = require('./panel');
const {
  createInteractionHandler,
  registerCommands,
  sendWelcome,
} = require('./interactions');
const { startHealthServer } = require('./health-server');

/**
 * Construit le prédicat « membre du staff ».
 *
 * Les identifiants de rôles sont testés en premier (O(rôles du membre), sans
 * parcours de chaîne), puis les noms configurés.
 *
 * @param {ReturnType<typeof import('./env').createConfig>} config
 */
function createStaffCheck(config) {
  const roleIds = new Set(config.staffRoleIds);
  const roleNames = new Set(config.staffRoles);
  const adminIds = new Set(config.adminIds);

  return function isStaff(member) {
    if (!member) return false;

    const userId = member.user?.id ?? member.id;
    if (userId && adminIds.has(userId)) return true;
    if (member.permissions?.has?.('Administrator')) return true;

    const roles = member.roles?.cache;
    if (!roles) return false;

    for (const role of roles.values()) {
      if (roleIds.has(role.id) || roleNames.has(role.name)) return true;
    }
    return false;
  };
}

/**
 * @param {{
 *   config: ReturnType<typeof import('./env').createConfig>,
 *   logger: import('./env').Logger,
 * }} options
 */
function createBot({ config, logger }) {
  /** @type {import('discord.js').Client | null} */
  let client = null;

  const persistence = createPersistence({
    file: config.dataFile,
    logger,
    debounceMs: config.persistDebounceMs,
    serialize: () => ({ ...store.serialize(), board: board?.board ?? null }),
  });

  const persisted = persistence.load();
  const store = new QueueStore({ persistedState: persisted });

  const board = createBoard({
    getClient: () => {
      if (!client) throw new Error('Client Discord non initialisé.');
      return client;
    },
    store,
    logger,
    minIntervalMs: config.minEditIntervalMs,
    render: (snapshot) => buildPanelPayload(snapshot, { pageSize: config.queuePageSize }),
    onBoardChanged: () => persistence.schedule(),
  });

  const isStaff = createStaffCheck(config);

  const interactions = createInteractionHandler({
    store,
    board,
    config,
    logger,
    persistence,
    isStaff,
  });

  const intents = [GatewayIntentBits.Guilds];
  if (config.enableMemberIntent && config.enableWelcome) {
    intents.push(GatewayIntentBits.GuildMembers);
  }

  /** @type {import('http').Server | null} */
  let health = null;

  function statusSnapshot() {
    return {
      uptimeSeconds: Math.round(process.uptime()),
      users: client?.user ? `${client.user.tag} (${client.user.id})` : 'connecting',
      guilds: client?.guilds?.cache.size ?? 0,
      queue: {
        revision: store.revision,
        waiting: store.normal.size + store.priority.size,
        priority: store.priority.size,
        fixing: store.fixing.size,
        current: store.current ? store.current.prenom : null,
      },
      board: board.board ?? null,
      boardStats: board.stats,
    };
  }

  /** Démarre le bot : login, commandes, restauration du panneau. */
  async function start() {
    client = new Client({ intents });

    client.once(Events.ClientReady, async () => {
      logger.info('Bot prêt.', { tag: client.user.tag, guilds: client.guilds.cache.size });

      try {
        const rest = new REST({ version: '10' }).setToken(config.token);
        await registerCommands({ rest, clientId: config.clientId, logger });
      } catch (error) {
        logger.error('Enregistrement des commandes impossible', {
          error: error?.message ?? error,
        });
      }

      if (config.restoreBoard && persisted?.board) {
        await board.restore(persisted.board);
      }

      if (persisted) {
        const restored = store.size;
        if (restored > 0) logger.info('File restaurée depuis le disque.', { students: restored });
      }
    });

    client.on(Events.InteractionCreate, (interaction) => {
      // Volontairement non attendu : chaque interaction est indépendante et
      // ses erreurs sont déjà gérées dans le handler.
      void interactions.handle(interaction);
    });

    if (config.enableWelcome && config.enableMemberIntent) {
      client.on(Events.GuildMemberAdd, (member) => {
        void sendWelcome({ member, config, logger });
      });
    }

    client.on(Events.Error, (error) => {
      logger.error('Erreur du client Discord', { error: error?.message ?? error });
    });

    client.on(Events.Warn, (message) => {
      logger.warn('Avertissement Discord', { message });
    });

    await client.login(config.token);

    health = startHealthServer({
      port: config.port,
      logger,
      status: statusSnapshot,
    });

    return client;
  }

  /** Arrêt propre : dernière édition du panneau puis sauvegarde. */
  async function stop(reason = 'shutdown') {
    logger.info('Arrêt du bot…', { reason });
    try {
      await board.retire('Bot arrêté — panneau inactif');
    } catch {
      // Un panneau déjà supprimé n'est pas un problème.
    }
    await persistence.close();
    board.dispose();
    health?.close();
    client?.destroy();
  }

  return {
    start,
    stop,
    status: statusSnapshot,
    get client() {
      return client;
    },
    store,
    board,
    persistence,
  };
}

module.exports = { createBot, createStaffCheck };
