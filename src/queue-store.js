'use strict';

/**
 * Modèle de données de la file d'attente.
 *
 * Toute la logique métier vit ici, sans aucune dépendance à discord.js :
 * elle est donc testable en isolation et réutilisable.
 *
 * Complexité (n = longueur de la file) :
 * - inscription / sortie / recherche : O(1) grâce aux `Map`;
 * - rendu du panneau : O(page) et non O(n), via `getSnapshot()`;
 * - sauvegarde disque : O(n) mais hors du chemin critique (débounce).
 *
 * Les `Map` conservent l'ordre d'insertion : elles fournissent à la fois
 * l'indice d'appartenance O(1) et l'ordre FIFO attendu par les étudiants.
 */

const GROUPS = Object.freeze(['1', '2', '3']);
const MAX_NAME_LENGTH = 32;
const MAX_QUEUE_LENGTH = 500;

/**
 * @typedef {'normal' | 'priority' | 'fixing' | 'current'} EntryLocation
 *
 * @typedef {object} QueueEntry
 * @property {string} discordId
 * @property {string} nom
 * @property {string} prenom
 * @property {string} groupe
 * @property {number} joinedAt
 * @property {number} [priorityAt]
 * @property {boolean} [isPriority]
 */

/** Erreur métier : le message est destiné à être montré à l'utilisateur. */
class QueueError extends Error {
  /**
   * @param {string} message
   * @param {string} [code]
   */
  constructor(message, code = 'QUEUE_ERROR') {
    super(message);
    this.name = 'QueueError';
    this.code = code;
  }
}

/**
 * Normalise une saisie libre (nom, prénom, groupe).
 *
 * @param {unknown} value
 * @returns {string}
 */
function normalizeText(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
}

/**
 * Valide les champs d'inscription et renvoie une entrée propre.
 *
 * @param {{ nom: unknown, prenom: unknown, groupe: unknown, discordId: string }} input
 * @returns {{ nom: string, prenom: string, groupe: string }}
 */
function validateStudentFields(input) {
  const nom = normalizeText(input.nom);
  const prenom = normalizeText(input.prenom);
  const groupe = normalizeText(input.groupe);

  if (nom === '' || prenom === '') {
    throw new QueueError('❌ Le nom et le prénom sont obligatoires.', 'INVALID_NAME');
  }
  if (!GROUPS.includes(groupe)) {
    throw new QueueError('❌ Groupe invalide. Indiquez 1, 2 ou 3.', 'INVALID_GROUP');
  }
  if (!input.discordId) {
    throw new QueueError('❌ Impossible d’identifier votre compte Discord.', 'NO_USER');
  }

  return { nom, prenom, groupe };
}

/** File d'attente en mémoire, sérialisable sur disque. */
class QueueStore {
  /**
   * @param {{ persistedState?: unknown, maxQueueLength?: number }} [options]
   */
  constructor({ persistedState, maxQueueLength = MAX_QUEUE_LENGTH } = {}) {
    /** @type {QueueEntry | null} */
    this.current = null;
    /** @type {Map<string, QueueEntry>} */
    this.priority = new Map();
    /** @type {Map<string, QueueEntry>} */
    this.normal = new Map();
    /** @type {Map<string, QueueEntry>} */
    this.fixing = new Map();

    /**
     * Garde-fou mémoire, pas une limite métier : une classe fait ~30 personnes.
     * Configurable pour ne jamais bloquer un vrai pic de TP.
     */
    this.maxQueueLength = maxQueueLength;
    /** Incrémenté à chaque mutation : sert à ignorer les rendus obsolètes. */
    this.revision = 0;

    if (persistedState) this.restore(persistedState);
  }

  /** Nombre total d'étudiants suivis (en attente + en cours + en correction). */
  get size() {
    return this.normal.size + this.priority.size + this.fixing.size + (this.current ? 1 : 0);
  }

  /** @returns {boolean} */
  get isEmpty() {
    return this.size === 0;
  }

  /**
   * Où se trouve un étudiant ? O(1).
   *
   * @param {string} discordId
   * @returns {EntryLocation | null}
   */
  locate(discordId) {
    if (this.current?.discordId === discordId) return 'current';
    if (this.priority.has(discordId)) return 'priority';
    if (this.normal.has(discordId)) return 'normal';
    if (this.fixing.has(discordId)) return 'fixing';
    return null;
  }

  /**
   * Position d'attente (1 = prochain passage) hors rectification. O(1).
   *
   * @param {string} discordId
   * @returns {number | null}
   */
  positionOf(discordId) {
    const location = this.locate(discordId);
    if (location === 'priority') {
      // Les rectifications passent en premier : le rang dépend de l'ordre
      // d'insertion de la Map, qu'on parcourt jusqu'à l'étudiant.
      let index = 0;
      for (const key of this.priority.keys()) {
        index += 1;
        if (key === discordId) return index;
      }
      return null;
    }
    if (location === 'normal') return this.priority.size + 1 + this.indexIn(this.normal, discordId);
    return null;
  }

  /**
   * @param {Map<string, QueueEntry>} map
   * @param {string} key
   */
  indexIn(map, key) {
    let index = 0;
    for (const current of map.keys()) {
      if (current === key) return index;
      index += 1;
    }
    return -1;
  }

  /**
   * Inscrit un étudiant dans la file normale. O(1).
   *
   * @param {{ discordId: string, nom: unknown, prenom: unknown, groupe: unknown }} input
   * @returns {QueueEntry}
   * @throws {QueueError} si l'étudiant est déjà inscrit ou la file saturée.
   */
  join(input) {
    const fields = validateStudentFields(input);
    const { discordId } = input;

    const location = this.locate(discordId);
    if (location !== null) {
      const messages = {
        current: '⚠️ Tu es déjà en train de passer.',
        priority: '⚠️ Tu es déjà dans la file de rectification.',
        normal: '⚠️ Tu es déjà inscrit dans la file.',
        fixing: '⚠️ Tu es déjà en rectification.',
      };
      throw new QueueError(messages[location] ?? '⚠️ Tu es déjà inscrit.', 'ALREADY_QUEUED');
    }

    if (this.normal.size >= this.maxQueueLength) {
      throw new QueueError('⚠️ La file est pleine, réessaie dans quelques minutes.', 'QUEUE_FULL');
    }

    /** @type {QueueEntry} */
    const entry = {
      discordId,
      nom: fields.nom,
      prenom: fields.prenom,
      groupe: fields.groupe,
      joinedAt: Date.now(),
    };

    this.normal.set(discordId, entry);
    this.touch();
    return entry;
  }

  /**
   * Retire l'étudiant de toutes les files. O(1).
   *
   * @param {string} discordId
   * @returns {boolean} `true` si quelque chose a été retiré.
   */
  leave(discordId) {
    const removedCurrent = this.current?.discordId === discordId;
    if (removedCurrent) this.current = null;

    // `delete` renvoie `false` si l'entrée n'existait pas ; on veut tenter
    // les trois suppressions sans court-circuiter, d'où l'absence de `||`.
    const removedNormal = this.normal.delete(discordId);
    const removedPriority = this.priority.delete(discordId);
    const removedFixing = this.fixing.delete(discordId);

    if (!removedCurrent && !removedNormal && !removedPriority && !removedFixing) {
      return false;
    }

    this.touch();
    return true;
  }

  /**
   * L'étudiant actuellement au tableau est déclaré en rectification. O(1).
   *
   * @param {string} discordId
   * @returns {QueueEntry}
   */
  markFixed(discordId) {
    const entry = this.fixing.get(discordId);
    if (!entry) {
      throw new QueueError('⛔ Tu n’es pas marqué en rectification.', 'NOT_FIXING');
    }
    this.fixing.delete(discordId);
    entry.priorityAt = Date.now();
    delete entry.isPriority;
    this.priority.set(discordId, entry);
    this.touch();
    return entry;
  }

  /**
   * Envoie l'étudiant au tableau en rectification. O(1).
   *
   * @returns {QueueEntry | null} l'étudiant déplacé, ou `null` si personne.
   */
  sendCurrentToFixing() {
    if (!this.current) return null;
    const entry = this.current;
    this.current = null;
    entry.isPriority = false;
    this.fixing.set(entry.discordId, entry);
    this.touch();
    return entry;
  }

  /**
   * Fait passer l'étudiant suivant.
   *
   * Le panneau n'affiche qu'une page ; retirer plusieurs entrées d'affilée
   * resterait O(1) par appel, contrairement à un `Array.shift()` répété.
   *
   * @param {{ skipCurrent?: boolean }} [options]
   * @returns {{ previous: QueueEntry | null, next: QueueEntry | null }}
   */
  advance({ skipCurrent = false } = {}) {
    const previous = skipCurrent ? null : this.current;

    /** @type {QueueEntry | null} */
    let next = null;
    const [priorityId] = this.priority.keys();
    if (priorityId !== undefined) {
      next = this.priority.get(priorityId) ?? null;
      if (next) this.priority.delete(priorityId);
    } else {
      const [normalId] = this.normal.keys();
      if (normalId !== undefined) {
        next = this.normal.get(normalId) ?? null;
        if (next) this.normal.delete(normalId);
      }
    }

    if (next) {
      next.isPriority = priorityId !== undefined;
      this.current = next;
    } else if (previous) {
      // Personne derrière : l'étudiant en cours reste au tableau.
      this.current = null;
    }

    if (previous || next) this.touch();
    return { previous, next };
  }

  /**
   * Déplace une rectification dans l'ordre d'attente prioritaire. O(n).
   *
   * @param {string} discordId
   * @param {number} delta  valeur négative = remonter, positive = descendre
   * @returns {number} la nouvelle position (1-based) ou -1 si introuvable.
   */
  movePriority(discordId, delta) {
    const ids = [...this.priority.keys()];
    const from = ids.indexOf(discordId);
    if (from === -1) return -1;

    const to = Math.min(Math.max(from + delta, 0), ids.length - 1);
    if (to === from) return from + 1;

    const [entry] = ids.splice(from, 1);
    ids.splice(to, 0, entry);

    this.priority = new Map(ids.map((id) => [id, this.priority.get(id)]));
    this.touch();
    return to + 1;
  }

  /**
   * Vue figée et prête à l'affichage, bornée à `pageSize` lignes par section.
   *
   * C'est le point clé de l'optimisation : la construction de l'embed ne
   * parcourt jamais l'intégralité de la file, seulement la page visible.
   *
   * @param {{ pageSize?: number, mention?: (id: string) => string }} [options]
   */
  getSnapshot({ pageSize = 8, mention = (id) => `<@${id}>` } = {}) {
    const take = (map, size) => {
      const items = [];
      for (const entry of map.values()) {
        if (items.length >= size) break;
        items.push(entry);
      }
      return items;
    };

    const current = this.current;

    return {
      revision: this.revision,
      current: current
        ? {
            ...current,
            mention: mention(current.discordId),
            waitingSince: current.joinedAt,
          }
        : null,
      priority: {
        total: this.priority.size,
        items: take(this.priority, pageSize),
      },
      normal: {
        total: this.normal.size,
        items: take(this.normal, pageSize),
      },
      fixing: {
        total: this.fixing.size,
        items: take(this.fixing, pageSize),
      },
      totals: {
        waiting: this.priority.size + this.normal.size,
        students: this.size,
      },
    };
  }

  /** Réinitialise complètement la file. */
  reset() {
    this.current = null;
    this.priority.clear();
    this.normal.clear();
    this.fixing.clear();
    this.touch();
  }

  /** Marque un changement d'état. */
  touch() {
    this.revision += 1;
    return this.revision;
  }

  /** État sérialisable (JSON) pour la reprise après redémarrage. */
  serialize() {
    return {
      version: 1,
      savedAt: Date.now(),
      current: this.current,
      priority: [...this.priority.values()],
      normal: [...this.normal.values()],
      fixing: [...this.fixing.values()],
    };
  }

  /**
   * Recharge un état précédemment sauvegardé, en ignorant les entrées
   * corrompues plutôt que de refuser de démarrer.
   *
   * @param {unknown} state
   * @returns {number} nombre d'entrées restaurées.
   */
  restore(state) {
    if (!state || typeof state !== 'object') return 0;

    const payload = /** @type {Record<string, unknown>} */ (state);
    const { current, priority, normal, fixing } = payload;

    const restoreMap = (target, items) => {
      if (!Array.isArray(items)) return 0;
      let restored = 0;
      for (const item of items) {
        const entry = restoreEntry(item);
        if (!entry || target.has(entry.discordId)) continue;
        target.set(entry.discordId, entry);
        restored += 1;
      }
      return restored;
    };

    const currentEntry = restoreEntry(current);
    if (currentEntry) this.current = currentEntry;

    const count =
      restoreMap(this.normal, normal) +
      restoreMap(this.priority, priority) +
      restoreMap(this.fixing, fixing);

    this.touch();
    return count;
  }
}

/**
 * @param {unknown} value
 * @returns {QueueEntry | null}
 */
function restoreEntry(value) {
  if (!value || typeof value !== 'object') return null;
  const entry = /** @type {Record<string, unknown>} */ (value);
  if (typeof entry.discordId !== 'string' || entry.discordId === '') return null;

  try {
    const fields = validateStudentFields({
      nom: entry.nom,
      prenom: entry.prenom,
      groupe: entry.groupe,
      discordId: entry.discordId,
    });

    /** @type {QueueEntry} */
    const restored = {
      discordId: entry.discordId,
      nom: fields.nom,
      prenom: fields.prenom,
      groupe: fields.groupe,
      joinedAt: Number.isFinite(entry.joinedAt) ? Number(entry.joinedAt) : Date.now(),
    };

    if (Number.isFinite(entry.priorityAt)) restored.priorityAt = Number(entry.priorityAt);
    if (entry.isPriority === true) restored.isPriority = true;
    return restored;
  } catch {
    return null;
  }
}

module.exports = {
  GROUPS,
  MAX_NAME_LENGTH,
  MAX_QUEUE_LENGTH,
  QueueError,
  QueueStore,
  normalizeText,
  restoreEntry,
  validateStudentFields,
};
