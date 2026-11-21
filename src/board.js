'use strict';

/**
 * Gestion du panneau unique (« board »).
 *
 * C'est ici que se joue l'essentiel de l'optimisation côté Discord :
 *
 * 1. **Coalescence** — N clics rapprochés (une classe entière qui s'inscrit en
 *    3 secondes) ne produisent qu'une seule édition du message, au lieu d'un
 *    `PATCH /channels/:id/messages/:id` par clic.
 * 2. **Throttle** — un intervalle minimal entre deux éditions évite de taper
 *    dans le rate-limit par salon de Discord (5 éditions / 5 s).
 * 3. **Dernier état gagnant** — l'édition part toujours du snapshot le plus
 *    récent, jamais d'un payload calculé avant les autres clics.
 * 4. **Repli robuste** — message supprimé (code 10008) : republication
 *    automatique ; permissions manquantes : on arrête proprement.
 */

/** Codes d'erreur JSON de Discord qui méritent un traitement particulier. */
const DISCORD_ERRORS = Object.freeze({
  UNKNOWN_MESSAGE: 10_008,
  UNKNOWN_CHANNEL: 10_003,
  MISSING_PERMISSIONS: 50_001,
  MISSING_ACCESS: 50_013,
});

/**
 * @typedef {import('./queue-store').QueueStore} QueueStore
 */

/**
 * @param {{
 *   getClient: () => import('discord.js').Client,
 *   store: QueueStore,
 *   logger: import('./env').Logger,
 *   render: (snapshot: ReturnType<QueueStore['getSnapshot']>) => object,
 *   minIntervalMs?: number,
 *   onBoardChanged?: (board: { channelId: string, messageId: string } | null) => void,
 * }} options
 */
function createBoard({ getClient, store, logger, render, minIntervalMs = 1500, onBoardChanged }) {
  /** @type {{ channelId: string, messageId: string } | null} */
  let board = null;
  /** @type {import('discord.js').Message | null} */
  let message = null;

  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  /** @type {Promise<void> | null} */
  let running = null;
  let lastEditAt = 0;
  let lastRenderedRevision = -1;
  let disposed = false;
  let disabledReason = '';

  const stats = { edits: 0, coalesced: 0, failures: 0, reposts: 0 };

  /** Construit le payload courant à partir du dernier état. */
  function currentPayload() {
    return render(store.getSnapshot());
  }

  /**
   * Rattache le panneau à un message existant.
   *
   * @param {{ channelId: string, messageId: string }} target
   */
  function attach(target) {
    board = { channelId: target.channelId, messageId: target.messageId };
    message = null;
    logger.debug('Panneau rattaché.', board);
    onBoardChanged?.(board);
  }

  /** Oublie le panneau courant (sans toucher au message Discord). */
  function detach() {
    board = null;
    message = null;
    onBoardChanged?.(null);
  }

  /** Indique qu'une réponse d'interaction a déjà mis le panneau à jour. */
  function markSynced(revision) {
    lastRenderedRevision = Math.max(lastRenderedRevision, revision);
    lastEditAt = Date.now();
  }

  /**
   * Peut-on répondre avec `interaction.update` sans risquer un 429 ?
   *
   * Vrai si aucune édition n'est en attente et si la dernière édition du
   * panneau date d'au moins `minIntervalMs`. Cela autorise une mise à jour
   * instantanée pour les clics espacés, tout en regroupant les rafales.
   */
  function canEditDirectly() {
    if (disposed || !board || running || timer) return false;
    return Date.now() - lastEditAt >= minIntervalMs;
  }

  /** Le message ciblé par une interaction est-il le panneau actif ? */
  function isCurrentMessage(messageId) {
    return board !== null && board.messageId === messageId;
  }

  /**
   * Signale une mutation de la file : programme une édition coalescée.
   */
  function invalidate() {
    if (disposed || !board) return;
    if (timer || running) {
      stats.coalesced += 1;
      return;
    }
    schedule();
  }

  function schedule() {
    if (timer || running || disposed || !board) return;

    const wait = Math.max(0, minIntervalMs - (Date.now() - lastEditAt));
    timer = setTimeout(() => {
      timer = null;
      void pump();
    }, wait);
    timer.unref?.();
  }

  /** Récupère (et met en cache) le message cible. */
  async function resolveMessage() {
    if (message) return message;
    if (!board) return null;

    const client = getClient();
    const channel = await client.channels.fetch(board.channelId).catch(() => null);
    if (!channel || !channel.isTextBased?.()) {
      throw Object.assign(new Error('Salon du panneau introuvable'), {
        code: DISCORD_ERRORS.UNKNOWN_CHANNEL,
      });
    }

    message = await channel.messages.fetch(board.messageId);
    return message;
  }

  /** Édition unique, série de l'état courant. */
  async function pump() {
    if (running || disposed || !board) return;

    const revision = store.revision;
    if (revision === lastRenderedRevision) return;

    running = (async () => {
      const target = await resolveMessage();
      if (!target) return;

      await target.edit(currentPayload());
      lastRenderedRevision = store.revision;
      lastEditAt = Date.now();
      stats.edits += 1;
    })();

    try {
      await running;
    } catch (error) {
      stats.failures += 1;
      await handleEditError(error);
    } finally {
      running = null;
      // Des clics ont pu arriver pendant l'édition : on repart pour un tour.
      if (!disposed && board && store.revision !== lastRenderedRevision) schedule();
    }
  }

  /**
   * @param {any} error
   */
  async function handleEditError(error) {
    const code = error?.code;

    if (code === DISCORD_ERRORS.UNKNOWN_MESSAGE) {
      logger.warn('Panneau supprimé côté Discord, republication…');
      message = null;
      stats.reposts += 1;
      await repost().catch((repostError) => {
        logger.error('Republication du panneau impossible', {
          error: repostError?.message ?? repostError,
        });
      });
      return;
    }

    if (
      code === DISCORD_ERRORS.MISSING_PERMISSIONS ||
      code === DISCORD_ERRORS.MISSING_ACCESS ||
      code === DISCORD_ERRORS.UNKNOWN_CHANNEL
    ) {
      disabledReason = code === DISCORD_ERRORS.UNKNOWN_CHANNEL ? 'salon introuvable' : 'permissions manquantes';
      logger.error('Édition du panneau impossible, synchronisation suspendue.', {
        reason: disabledReason,
        code,
      });
      detach();
      return;
    }

    logger.warn('Échec d’édition du panneau (nouvel essai programmé).', {
      error: error?.message ?? error,
      code,
    });
  }

  /** Republie le panneau dans le même salon (message supprimé). */
  async function repost() {
    if (!board) return null;
    const client = getClient();
    const channel = await client.channels.fetch(board.channelId).catch(() => null);
    if (!channel || !channel.isTextBased?.()) {
      detach();
      return null;
    }
    const sent = await channel.send(currentPayload());
    board = { channelId: channel.id, messageId: sent.id };
    message = sent;
    lastRenderedRevision = store.revision;
    lastEditAt = Date.now();
    onBoardChanged?.(board);
    logger.info('Panneau republié.', board);
    return sent;
  }

  /**
   * Publie un nouveau panneau dans un salon et le rend actif.
   *
   * @param {import('discord.js').TextBasedChannel} channel
   */
  async function publish(channel) {
    const sent = await channel.send(currentPayload());
    board = { channelId: channel.id, messageId: sent.id };
    message = sent;
    lastRenderedRevision = store.revision;
    lastEditAt = Date.now();
    onBoardChanged?.(board);
    logger.info('Panneau publié.', board);
    return sent;
  }

  /**
   * Enregistre un panneau créé autrement (réponse à une interaction).
   *
   * @param {import('discord.js').Message} sent
   */
  function adopt(sent) {
    board = { channelId: sent.channelId, messageId: sent.id };
    message = sent;
    lastRenderedRevision = store.revision;
    lastEditAt = Date.now();
    onBoardChanged?.(board);
    return board;
  }

  /**
   * Restaure le panneau sauvegardé au démarrage.
   *
   * @param {{ channelId: string, messageId: string } | null} saved
   */
  async function restore(saved) {
    if (!saved || !saved.channelId || !saved.messageId) return false;
    attach(saved);
    try {
      const target = await resolveMessage();
      // On profite du passage pour remettre le panneau à niveau.
      await target.edit(currentPayload());
      lastRenderedRevision = store.revision;
      lastEditAt = Date.now();
      stats.edits += 1;
      logger.info('Panneau restauré après redémarrage.', board);
      return true;
    } catch (error) {
      logger.warn('Panneau sauvegardé introuvable, il sera republié au prochain /tp-start.', {
        error: error?.message ?? error,
        code: error?.code,
      });
      detach();
      return false;
    }
  }

  /** Détache le panneau existant (il devient obsolète). */
  async function retire(reason = 'Panneau remplacé par un nouveau /tp-start') {
    if (!board) return;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    try {
      if (message) {
        await message.edit({
          content: `⚠️ ${reason}.`,
          embeds: [],
          components: [],
        });
      } else {
        const target = await resolveMessage();
        await target?.edit({ content: `⚠️ ${reason}.`, embeds: [], components: [] });
      }
    } catch {
      // Un panneau déjà supprimé n'est pas une erreur.
    }
    detach();
  }

  /** Attend la fin de l'édition en cours (arrêt propre, tests). */
  async function settle() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (running) await running.catch(() => {});
    if (board && store.revision !== lastRenderedRevision) await pump();
  }

  function dispose() {
    disposed = true;
    if (timer) clearTimeout(timer);
    timer = null;
    detach();
  }

  return {
    get board() {
      return board;
    },
    get stats() {
      return { ...stats, disabledReason };
    },
    adopt,
    attach,
    canEditDirectly,
    detach,
    dispose,
    invalidate,
    isCurrentMessage,
    markSynced,
    publish,
    retire,
    restore,
    settle,
    get payload() {
      return currentPayload();
    },
  };
}

module.exports = { DISCORD_ERRORS, createBoard };
