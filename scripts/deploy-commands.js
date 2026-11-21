'use strict';

/**
 * Enregistre les commandes slash sans lancer le bot.
 *
 * Utile après un changement de commandes, ou quand `client.login` est bloqué
 * par une coupure réseau :
 *
 *   npm run deploy:commands
 */

const { REST } = require('discord.js');

const { loadDotEnv, createConfig, createLogger, missingRequired } = require('./src/env');
const { registerCommands } = require('./src/interactions');

loadDotEnv();

const config = createConfig();
const logger = createLogger(config.logLevel);

const missing = missingRequired(config);
if (missing.length > 0) {
  logger.error('Configuration incomplète : variables obligatoires manquantes.', { missing });
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(config.token);

registerCommands({ rest, clientId: config.clientId, logger })
  .then((body) => {
    logger.info('Terminé.', { commands: body.map((command) => command.name) });
  })
  .catch((error) => {
    logger.error('Enregistrement impossible', { error: error?.message ?? error });
    process.exit(1);
  });
