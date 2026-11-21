'use strict';

/**
 * Persistance de l'état sur disque.
 *
 * Objectif : survivre à un redémarrage (Railway, crash, redéploiement) sans
 * jamais bloquer le chemin critique des interactions. Les écritures sont :
 *  - regroupées (debounce) : 50 inscriptions simultanées = 1 seule écriture ;
 *  - atomiques (fichier temporaire + `rename`) : jamais d'état tronqué ;
 *  - sérialisées : deux écritures ne peuvent pas s'entrelacer ;
 *  - non bloquantes : `fs/promises`, rien d'asynchrone dans le gestionnaire
 *    d'interaction.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

/**
 * @callback Logger
 * @property {Function} debug
 * @property {Function} info
 * @property {Function} warn
 * @property {Function} error
 */

/**
 * @param {{
 *   file: string,
 *   logger: Logger,
 *   debounceMs?: number,
 *   serialize: () => unknown,
 * }} options
 */
function createPersistence({ file, logger, debounceMs = 1000, serialize }) {
  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  /** @type {Promise<void>} */
  let pending = Promise.resolve();
  let closed = false;

  /** Écrit l'état de façon atomique. */
  async function write() {
    const payload = JSON.stringify(serialize());
    const directory = path.dirname(file);
    const temporary = `${file}.${process.pid}.tmp`;

    await fsp.mkdir(directory, { recursive: true });
    await fsp.writeFile(temporary, payload, 'utf8');
    await fsp.rename(temporary, file);
  }

  /** Intercale une écriture dans la file d'attente interne. */
  function enqueue() {
    pending = pending.then(write).catch((error) => {
      logger.error('Sauvegarde de la file impossible', { error: error?.message ?? error });
    });
    return pending;
  }

  /** Programme une sauvegarde ; les appels rapprochés sont fusionnés. */
  function schedule() {
    if (closed) return;
    if (timer) clearTimeout(timer);

    timer = setTimeout(() => {
      timer = null;
      void enqueue();
    }, debounceMs);

    // Une sauvegarde en attente ne doit pas retarder l'extinction du process.
    timer.unref?.();
  }

  /** Force une sauvegarde immédiate (arrêt du bot, `/tp-start`). */
  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    return enqueue();
  }

  /** Charge l'état précédent, ou `null` s'il n'y en a pas. */
  function load() {
    try {
      const contents = fs.readFileSync(file, 'utf8');
      return JSON.parse(contents);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        logger.info('Aucun état sauvegardé : démarrage avec une file vide.');
        return null;
      }
      logger.warn('État sauvegardé illisible, ignoré.', {
        file,
        error: error?.message ?? error,
      });
      return null;
    }
  }

  /** Termine proprement (SIGINT/SIGTERM). */
  async function close() {
    if (closed) return;
    await flush();
    closed = true;
  }

  return { load, schedule, flush, close, file };
}

module.exports = { createPersistence };
