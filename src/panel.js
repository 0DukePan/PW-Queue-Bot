'use strict';

/**
 * Rendu du panneau de file d'attente.
 *
 * Le rendu ne consomme qu'un *snapshot* déjà borné par `QueueStore.getSnapshot()` :
 * on ne parcourt donc jamais toute la file pour construire l'embed, et les
 * limites dures de Discord (1024 caractères par champ) sont respectées par
 * construction puisque `pageSize` est plafonné (3..20).
 */

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const COLORS = Object.freeze({
  idle: 0x5865f2,
  active: 0x57f287,
  priority: 0xfaa61a,
  fixing: 0xeb459e,
});

/** Longueur maximale d'un nom affiché dans l'embed. */
const DISPLAY_NAME_MAX = 24;

/** Limite dure de Discord pour la valeur d'un champ d'embed. */
const FIELD_VALUE_MAX = 1024;

/** Marge réservée à la ligne « … et N autres ». */
const OVERFLOW_RESERVE = 48;

/** Identifiants de boutons (regroupés pour éviter les fautes de frappe). */
const IDS = Object.freeze({
  join: 'tp_join_modal',
  fixed: 'tp_fixed',
  leave: 'tp_leave',
  next: 'tp_next',
  sendFix: 'tp_send_fix',
  welcome: 'welcome_private',
  modalJoin: 'tp_modal_join',
});

/**
 * Tronque proprement un nom pour l'affichage.
 *
 * @param {string} name
 * @returns {string}
 */
function displayName(name) {
  const value = String(name ?? '').trim();
  if (value.length <= DISPLAY_NAME_MAX) return value;
  return `${value.slice(0, DISPLAY_NAME_MAX - 1)}…`;
}

/**
 * @param {import('./queue-store').QueueEntry} entry
 * @returns {string}
 */
function shortLabel(entry) {
  return `${displayName(entry.nom)} ${displayName(entry.prenom)}`;
}

/**
 * Ligne « … et N autres en attente ».
 *
 * @param {number} hidden
 */
function overflowLine(hidden) {
  return `*… et ${hidden} autre${hidden > 1 ? 's' : ''} en attente*`;
}

/**
 * Construit la liste numérotée d'une section, avec la mention de dépassement.
 *
 * La valeur est bornée à `FIELD_VALUE_MAX` caractères : même avec des noms
 * longs et une page pleine, l'embed reste valide et l'édition du panneau ne
 * peut pas être rejetée par l'API (cause classique de panneau figé).
 *
 * @param {{ total: number, items: import('./queue-store').QueueEntry[] }} section
 * @param {{ startIndex?: number, icon?: string, withMention?: boolean, maxLength?: number }} [options]
 */
function renderSection(
  section,
  { startIndex = 1, icon = '', withMention = false, maxLength = FIELD_VALUE_MAX } = {}
) {
  if (section.total === 0) return '*Vide*';

  const budget = maxLength - OVERFLOW_RESERVE;
  /** @type {string[]} */
  const lines = [];
  let length = 0;

  for (const entry of section.items) {
    const position = startIndex + lines.length;
    const mention = withMention ? ` — <@${entry.discordId}>` : '';
    const badge = icon ? `${icon} ` : '';
    const line = `**${position}.** ${badge}**${shortLabel(entry)}** (G${entry.groupe})${mention}`;

    const projected = length + line.length + (lines.length > 0 ? 1 : 0);
    if (projected > budget) break;

    lines.push(line);
    length = projected;
  }

  // Une seule ligne trop longue : on la tronque plutôt que de rendre un champ vide.
  if (lines.length === 0 && section.items.length > 0) {
    const entry = section.items[0];
    return `**${startIndex}.** ${shortLabel(entry)} (G${entry.groupe})`.slice(0, maxLength);
  }

  const hidden = section.total - lines.length;
  if (hidden > 0) lines.push(overflowLine(hidden));

  return lines.join('\n');
}


/**
 * Rendu de la section « en cours d'ajustement », borné lui aussi.
 *
 * @param {{ total: number, items: import('./queue-store').QueueEntry[] }} fixing
 */
function renderFixing(fixing) {
  if (fixing.total === 0) return '*Aucun*';

  /** @type {string[]} */
  const parts = [];
  let length = 0;

  for (const entry of fixing.items) {
    const part = `🛠️ **${shortLabel(entry)}** (G${entry.groupe})`;
    const projected = length + part.length + (parts.length > 0 ? 2 : 0);
    if (projected > FIELD_VALUE_MAX - OVERFLOW_RESERVE) break;
    parts.push(part);
    length = projected;
  }

  if (parts.length === 0) {
    const entry = fixing.items[0];
    return `🛠️ **${shortLabel(entry)}** (G${entry.groupe})`.slice(0, FIELD_VALUE_MAX);
  }

  const hidden = fixing.total - parts.length;
  const suffix = hidden > 0 ? ` *(+${hidden})*` : '';
  return parts.join(', ') + suffix;
}

/**
 * Couleur de l'embed selon l'état courant.
 *
 * @param {ReturnType<import('./queue-store').QueueStore['getSnapshot']>} snapshot
 */
function pickColor(snapshot) {
  if (snapshot.current) return COLORS.active;
  if (snapshot.fixing.total > 0) return COLORS.fixing;
  if (snapshot.priority.total > 0) return COLORS.priority;
  return COLORS.idle;
}

/**
 * Construit le message complet du panneau (embed + boutons).
 *
 * @param {ReturnType<import('./queue-store').QueueStore['getSnapshot']>} snapshot
 * @param {{ pageSize?: number }} [options]
 */
function buildPanelPayload(snapshot, { pageSize = 8 } = {}) {
  const { current, priority, normal, fixing, totals } = snapshot;

  const currentText = current
    ? `🟢 **${shortLabel(current)}** (G${current.groupe}) — <@${current.discordId}>` +
      `${current.isPriority ? ' *(Retour rectification)*' : ''}`
    : '*Aucun étudiant en cours de passage*';

  const fixingText = renderFixing(fixing);

  const embed = new EmbedBuilder()
    .setTitle('File d’attente TP')
    .setColor(pickColor(snapshot))
    .addFields(
      {
        name: '🎙️ En partage d’écran (Salon Vocal)',
        value: currentText,
      },
      {
        name: `⚡ File de Rectifications (${priority.total})`,
        value: renderSection(priority, { icon: '⚡' }),
      },
      {
        name: `⏳ File d’attente (FIFO) (${normal.total})`,
        value: renderSection(normal, { startIndex: priority.total + 1 }),
      },
      {
        name: '🔧 En cours d’ajustement (Rectification)',
        value: fixingText,
      }
    )
    .setFooter({
      text: `${totals.waiting} en attente · ${totals.students} suivis — Système propre sans spam`,
    })
    .setTimestamp();

  return {
    embeds: [embed],
    components: [buildStudentRow(), buildStaffRow()],
  };
}

/** Rangée de boutons destinée aux étudiants. */
function buildStudentRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(IDS.join)
      .setLabel('✋ Rejoindre la file')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(IDS.fixed)
      .setLabel('⚡ Rectification finie')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(IDS.leave)
      .setLabel('❌ Quitter la file')
      .setStyle(ButtonStyle.Secondary)
  );
}

/** Rangée de boutons réservée au staff. */
function buildStaffRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(IDS.next)
      .setLabel('▶️ Suivant (Prof/Délégué)')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(IDS.sendFix)
      .setLabel('↺ Renvoyer en rectification')
      .setStyle(ButtonStyle.Danger)
  );
}

module.exports = {
  COLORS,
  DISPLAY_NAME_MAX,
  FIELD_VALUE_MAX,
  IDS,
  buildPanelPayload,
  buildStaffRow,
  buildStudentRow,
  displayName,
  overflowLine,
  pickColor,
  renderFixing,
  renderSection,
  shortLabel,
};
