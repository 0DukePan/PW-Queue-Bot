'use strict';

/**
 * Configuration et journalisation.
 *
 * Tout est lu depuis l'environnement, avec des valeurs par défaut sûres, afin
 * que le bot puisse tourner sans `.env` (Railway) comme avec `.env` (local).
 */

const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');

const LOG_LEVELS = Object.freeze({ error: 0, warn: 1, info: 2, debug: 3 });

/**
 * @typedef {object} Logger
 * @property {string} level
 * @property {(message: string, fields?: Record<string, unknown>) => void} error
 * @property {(message: string, fields?: Record<string, unknown>) => void} warn
 * @property {(message: string, fields?: Record<string, unknown>) => void} info
 * @property {(message: string, fields?: Record<string, unknown>) => void} debug
 */

/**
 * Parse un fichier .env minimaliste (KEY=value, commentaires `#`, quotes).
 *
 * @param {string} contents
 * @returns {Map<string, string>}
 */
function parseDotEnv(contents) {
  const entries = new Map();

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const separator = withoutExport.indexOf('=');
    if (separator <= 0) continue;

    const key = withoutExport.slice(0, separator).trim();
    if (key === '') continue;

    let value = withoutExport.slice(separator + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length > 1 && value.endsWith(quote)) {
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"');
      }
    }
    entries.set(key, value);
  }

  return entries;
}

/**
 * Charge un fichier `.env` sans écraser les variables déjà définies.
 *
 * @param {string} file
 * @returns {boolean} `true` si au moins une variable a été ajoutée.
 */
function loadDotEnv(file = path.join(process.cwd(), '.env')) {
  let contents;
  try {
    contents = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }

  let loaded = false;
  for (const [key, value] of parseDotEnv(contents)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
      loaded = true;
    }
  }
  return loaded;
}

/**
 * Construit la configuration typée à partir d'un objet d'environnement.
 *
 * @param {Record<string, string | undefined>} [env]
 */
function createConfig(env = process.env) {
  const readString = (name, fallback) => {
    const raw = env[name];
    if (raw === undefined) return fallback;
    const trimmed = String(raw).trim();
    return trimmed === '' ? fallback : trimmed;
  };

  const readInt = (name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
    const raw = env[name];
    if (raw === undefined || String(raw).trim() === '') return fallback;
    const parsed = Number.parseInt(String(raw).trim(), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(parsed, min), max);
  };

  const readBool = (name, fallback) => {
    const raw = readString(name, '');
    if (raw === '') return fallback;
    return ['1', 'true', 'yes', 'on', 'oui'].includes(raw.toLowerCase());
  };

  const readList = (name, fallback) => {
    const raw = readString(name, '');
    if (raw === '') return [...fallback];
    const values = raw
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value !== '');
    return values.length > 0 ? values : [...fallback];
  };

  return Object.freeze({
    token: readString('DISCORD_TOKEN', ''),
    clientId: readString('DISCORD_CLIENT_ID', ''),

    /** Rôles (par nom) autorisés à piloter la file. */
    staffRoles: readList('STAFF_ROLES', ['Prof', 'Délégué']),
    /** Rôles (par identifiant) — prioritaire sur `STAFF_ROLES` s'il est renseigné. */
    staffRoleIds: readList('STAFF_ROLE_IDS', []),
    /** Identifiants Discord toujours autorisés (dépannage). */
    adminIds: readList('ADMIN_IDS', []),

    /** Nombre d'étudiants affichés par section de l'embed. */
    queuePageSize: readInt('QUEUE_PAGE_SIZE', 8, { min: 3, max: 20 }),
    /** Intervalle minimal entre deux éditions du panneau (anti-429). */
    minEditIntervalMs: readInt('QUEUE_MIN_EDIT_INTERVAL_MS', 1500, { min: 250, max: 60_000 }),
    /** Fréquence de sauvegarde de l'état sur disque. */
    persistDebounceMs: readInt('QUEUE_PERSIST_DEBOUNCE_MS', 1000, { min: 100, max: 60_000 }),

    /** Fichier d'état (reprise après redémarrage). */
    dataFile: path.resolve(process.cwd(), readString('QUEUE_DATA_FILE', 'data/queue-state.json')),

    /** Salon où republier le panneau au démarrage, si fourni. */
    queueChannelId: readString('QUEUE_CHANNEL_ID', ''),
    /** Recharge les boutons sur le panneau persistant au démarrage. */
    restoreBoard: readBool('QUEUE_RESTORE_BOARD', true),

    /** Salon du message de bienvenue (sinon recherche par nom). */
    welcomeChannelId: readString('WELCOME_CHANNEL_ID', ''),
    enableWelcome: readBool('ENABLE_WELCOME', true),
    /** L'intent privilégié GuildMembers est nécessaire pour `guildMemberAdd`. */
    enableMemberIntent: readBool('ENABLE_MEMBER_INTENT', true),

    /**
     * Serveur utilisé par `scripts/verify-live.js`.
     * Volontairement séparé du reste : le script refuse de deviner sur quel
     * serveur travailler, pour ne jamais créer de salon par accident.
     */
    guildIdForVerify: readString('GUILD_ID', ''),

    /** Port du serveur de health-check (Railway le fournit). */
    port: readInt('PORT', 0, { min: 0, max: 65_535 }),

    logLevel: readString('LOG_LEVEL', 'info').toLowerCase(),
  });
}

/**
 * Vérifie les variables obligatoires et renvoie la liste des manquantes.
 *
 * @param {ReturnType<typeof createConfig>} config
 */
function missingRequired(config) {
  const missing = [];
  if (!config.token) missing.push('DISCORD_TOKEN');
  if (!config.clientId) missing.push('DISCORD_CLIENT_ID');
  return missing;
}

/**
 * Crée l'objet de journalisation filtré par `LOG_LEVEL`.
 *
 * @param {string} level
 * @returns {Logger}
 */
function createLogger(level = 'info') {
  const threshold = LOG_LEVELS[level] ?? LOG_LEVELS.info;

  const emit = (method, name, stream) => (message, fields) => {
    if ((LOG_LEVELS[name] ?? 99) > threshold) return;
    const stamp = new Date().toISOString();
    const suffix =
      fields === undefined
        ? ''
        : ` ${util.inspect(fields, { depth: 2, breakLength: Infinity, colors: false })}`;
    stream(`${stamp} [${name.toUpperCase()}] ${message}${suffix}`);
  };

  return {
    level,
    error: emit(console.error, 'error', console.error),
    warn: emit(console.warn, 'warn', console.warn),
    info: emit(console.log, 'info', console.log),
    debug: emit(console.log, 'debug', console.log),
  };
}

module.exports = {
  LOG_LEVELS,
  parseDotEnv,
  loadDotEnv,
  createConfig,
  missingRequired,
  createLogger,
};
