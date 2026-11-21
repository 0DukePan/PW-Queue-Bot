'use strict';

/**
 * Point d'entrée du bot.
 *
 * Charge `.env` si présent, valide la configuration, démarre le bot et gère
 * l'arrêt propre (Railway envoie SIGTERM à chaque redéploiement).
 */

const { loadDotEnv, createConfig, createLogger, missingRequired } = require('./src/env');
const { createBot } = require('./src/bot');

loadDotEnv();

const config = createConfig();
const logger = createLogger(config.logLevel);

const missing = missingRequired(config);
if (missing.length > 0) {
  logger.error('Configuration incomplète : variables obligatoires manquantes.', { missing });
  process.exit(1);
}

const bot = createBot({ config, logger });

let stopping = false;

/**
 * Arrêt propre, idempotent et borné dans le temps.
 *
 * @param {string} reason
 */
async function shutdown(reason) {
  if (stopping) return;
  stopping = true;

  const forceExit = setTimeout(() => {
    logger.warn('Arrêt forcé : le nettoyage a dépassé 8 s.');
    process.exit(1);
  }, 8000);
  forceExit.unref?.();

  try {
    await bot.stop(reason);
  } catch (error) {
    logger.error('Erreur pendant l’arrêt', { error: error?.message ?? error });
  } finally {
    clearTimeout(forceExit);
    process.exit(0);
  }
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

process.on('unhandledRejection', (reason) => {
  logger.error('Promesse rejetée non gérée', {
    error: reason instanceof Error ? reason.message : String(reason),
  });
});

process.on('uncaughtException', (error) => {
  logger.error('Exception non interceptée', { error: error?.message ?? error, stack: error?.stack });
  void shutdown('uncaughtException');
});

bot
  .start()
  .catch((error) => {
    logger.error('Démarrage impossible', { error: error?.message ?? error });
    process.exit(1);
  });
