'use strict';

/**
 * Gestion des interactions Discord — cœur du débit du bot.
 *
 * Stratégie de réponse (du plus rapide au plus sûr) :
 *
 *  1. **Mise à jour directe** (`interaction.update`) quand l'interaction vient
 *     du panneau actif et qu'aucune édition n'a eu lieu récemment : une seule
 *     requête, mise à jour instantanée pour tout le salon, aucun message
 *     parasite. C'est le cas courant (un étudiant clique, le suivant suit).
 *  2. **Acquittement éphémère + édition coalescée** quand les clics
 *     s'enchaînent : on répond tout de suite en privé et `board` regroupe les
 *     éditions. C'est ce qui protège du rate-limit quand toute la classe
 *     s'inscrit en même temps.
 *  3. **Réponse éphémère seule** pour les erreurs : rien à rafraîchir.
 *
 * Aucune de ces branches ne fait d'`await` susceptible de dépasser les 3 s
 * accordées au token d'interaction autrement que par une requête Discord.
 */

const {
  MessageFlags,
  ModalBuilder,
  ActionRowBuilder,
  TextInputBuilder,
  TextInputStyle,
  SlashCommandBuilder,
  REST,
  Routes,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const { IDS, buildPanelPayload } = require('./panel');
const { QueueError } = require('./queue-store');

/** Réponses éphémères pré-construites (allocation unique). */
const EPHEMERAL = Object.freeze({ flags: MessageFlags.Ephemeral });

/**
 * Interaction déjà acquittée ou expirée : ce n'est pas une erreur applicative.
 *
 * @param {unknown} error
 */
function isExpiredInteraction(error) {
  const code = /** @type {any} */ (error)?.code;
  return code === 10_062 || code === 40_060;
}

/**
 * @param {{
 *   store: import('./queue-store').QueueStore,
 *   board: ReturnType<typeof import('./board').createBoard>,
 *   config: ReturnType<typeof import('./env').createConfig>,
 *   logger: import('./env').Logger,
 *   persistence: ReturnType<typeof import('./persistence').createPersistence>,
 *   isStaff: (member: any) => boolean,
 * }} deps
 */
function createInteractionHandler({ store, board, config, logger, persistence, isStaff }) {
  /** Rendu borné partagé : un snapshot par affichage, jamais plus. */
  const render = () => buildPanelPayload(store.getSnapshot(), { pageSize: config.queuePageSize });

  /** Écriture disque différée : jamais sur le chemin critique. */
  const persist = () => persistence.schedule();

  /**
   * Répond en éphémère sans jamais casser le handler si le token a expiré.
   *
   * @param {any} interaction
   * @param {string} content
   */
  async function ephemeral(interaction, content) {
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content, ...EPHEMERAL });
      } else {
        await interaction.reply({ content, ...EPHEMERAL });
      }
    } catch (error) {
      if (!isExpiredInteraction(error)) {
        logger.warn('Réponse éphémère impossible', { error: error?.message ?? error });
      }
    }
  }

  /**
   * Acquitte, informe l'utilisateur, puis laisse `board` rafraîchir le panneau.
   *
   * @param {any} interaction
   * @param {string} content
   */
  async function ackDeferred(interaction, content) {
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.deferReply({ ...EPHEMERAL });
      }
      await interaction.editReply({ content });
    } catch (error) {
      if (!isExpiredInteraction(error)) {
        logger.warn('Accusé de réception impossible', { error: error?.message ?? error });
      }
    }
    board.invalidate();
    persist();
  }

  /**
   * Réponse d'une action qui modifie la file.
   *
   * On privilégie `interaction.update` (1 requête, panneau mis à jour
   * immédiatement) tant que le débit reste sous le seuil anti-429 ; au-delà,
   * bascule sur l'acquittement éphémère + édition coalescée.
   *
   * @param {any} interaction
   * @param {string} content message privé affiché seulement en mode dégradé
   */
  async function respondWithPanel(interaction, content) {
    const fromBoard = board.isCurrentMessage(interaction.message?.id);

    if (fromBoard && board.canEditDirectly()) {
      try {
        // Le rendu a lieu *après* la mutation, et la mutation est synchrone :
        // le payload reflète donc toujours l'état le plus récent.
        await interaction.update(render());
        board.markSynced(store.revision);
        persist();
        return;
      } catch (error) {
        if (isExpiredInteraction(error)) return;
        logger.warn('Mise à jour directe du panneau impossible, repli.', {
          error: error?.message ?? error,
          code: error?.code,
        });
      }
    }

    await ackDeferred(interaction, content);
  }

  /** Le panneau est-il encore pilotable ? Sinon on explique pourquoi. */
  async function rejectStaleBoard(interaction) {
    if (board.isCurrentMessage(interaction.message?.id)) return false;
    await ephemeral(
      interaction,
      '⚠️ Ce panneau est obsolète. Utilise le plus récent (ou relance `/tp-start`).'
    );
    return true;
  }

  /** `/tp-start` : neutralise l'ancien panneau puis en publie un neuf. */
  async function handleStart(interaction) {
    if (!isStaff(interaction.member)) {
      return ephemeral(interaction, '⛔ Réservé au Prof ou aux Délégués.');
    }
    if (!interaction.channel?.isTextBased?.()) {
      return ephemeral(interaction, '⛔ Utilise cette commande dans un salon textuel.');
    }

    // Un `deferReply` garantit qu'on reste dans les 3 s même si la publication
    // du panneau est lente (Discord rame, salon saturé).
    try {
      await interaction.deferReply({ ...EPHEMERAL });
    } catch (error) {
      if (isExpiredInteraction(error)) return;
      throw error;
    }

    try {
      // Deux panneaux actifs en parallèle désynchroniseraient les étudiants.
      await board.retire();

      store.reset();
      const message = await board.publish(interaction.channel);

      await interaction.editReply({
        content: `✅ File relancée : ${message.url}`,
      });

      persist();
      logger.info('File réinitialisée via /tp-start.', {
        channelId: interaction.channelId,
        by: interaction.user?.id,
      });
    } catch (error) {
      logger.error('Impossible de lancer la file', {
        error: error?.message ?? error,
        code: error?.code,
      });
      await interaction.editReply({ content: '❌ Impossible de publier le panneau dans ce salon.' });
    }
  }

  /** Bouton « Rejoindre » : vérification O(1) puis formulaire. */
  async function handleJoinButton(interaction) {
    const location = store.locate(interaction.user.id);
    if (location !== null) {
      return ephemeral(interaction, alreadyQueuedMessage(location));
    }

    const modal = new ModalBuilder()
      .setCustomId(IDS.modalJoin)
      .setTitle('Informations Étudiant - TP');

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('nom')
          .setLabel('Nom')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(32)
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('prenom')
          .setLabel('Prénom')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(32)
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('groupe')
          .setLabel('Groupe (1, 2 ou 3)')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(1)
          .setPlaceholder('1, 2 ou 3')
          .setRequired(true)
      )
    );

    // `showModal` vaut acquittement : aucune requête supplémentaire.
    return interaction.showModal(modal);
  }

  /**
   * Soumission du formulaire. Le pic de charge du bot : 30 étudiants qui
   * valident en même temps.
   */
  async function handleJoinModal(interaction) {
    let content;
    try {
      const entry = store.join({
        discordId: interaction.user.id,
        nom: interaction.fields.getTextInputValue('nom'),
        prenom: interaction.fields.getTextInputValue('prenom'),
        groupe: interaction.fields.getTextInputValue('groupe'),
      });

      const position = store.positionOf(entry.discordId);
      content =
        `✅ Inscription validée (${entry.nom} ${entry.prenom} - G${entry.groupe}). ` +
        `Tu es **${position}ᵉ** dans la file — regarde le tableau.`;
    } catch (error) {
      if (error instanceof QueueError) return ephemeral(interaction, error.message);
      logger.error('Inscription impossible', { error: error?.message ?? error });
      return ephemeral(interaction, '❌ Inscription impossible, réessaie dans un instant.');
    }

    // Confirmation privée (le panneau, lui, est rafraîchi une seule fois pour
    // tout le lot d'inscriptions simultanées).
    await ephemeral(interaction, content);
    board.invalidate();
    persist();
  }

  /** Bouton « Rectification finie ». */
  async function handleFixed(interaction) {
    try {
      const entry = store.markFixed(interaction.user.id);
      await respondWithPanel(
        interaction,
        `⚡ ${entry.nom} ${entry.prenom} repassera en priorité.`
      );
    } catch (error) {
      if (error instanceof QueueError) return ephemeral(interaction, error.message);
      logger.error('Passage en priorité impossible', { error: error?.message ?? error });
    }
  }

  /** Bouton « Quitter la file ». */
  async function handleLeave(interaction) {
    const removed = store.leave(interaction.user.id);
    if (!removed) return ephemeral(interaction, '⚠️ Tu n’étais pas dans la file.');
    await respondWithPanel(interaction, '❌ Tu as quitté la file.');
  }

  /** Bouton « Suivant » (staff). */
  async function handleNext(interaction) {
    if (!isStaff(interaction.member)) {
      return ephemeral(interaction, '⛔ Action réservée au Prof ou aux Délégués.');
    }

    const { next } = store.advance();
    const content = next
      ? `▶️ Au tour de **${next.nom} ${next.prenom}** (G${next.groupe}).`
      : '📭 Plus personne dans la file.';

    await respondWithPanel(interaction, content);
  }

  /** Bouton « Renvoyer en rectification » (staff). */
  async function handleSendFix(interaction) {
    if (!isStaff(interaction.member)) {
      return ephemeral(interaction, '⛔ Action réservée au Prof ou aux Délégués.');
    }

    const moved = store.sendCurrentToFixing();
    if (!moved) return ephemeral(interaction, '⚠️ Aucun étudiant en cours de passage.');

    // « Suivant » suit généralement dans la seconde : la coalescence du panneau
    // évite deux éditions pour une seule action staff.
    await respondWithPanel(interaction, `↺ **${moved.nom} ${moved.prenom}** est envoyé en rectification.`);
  }

  /** Guide d'accueil éphémère (bouton du message de bienvenue). */
  async function handleWelcomeButton(interaction) {
    const targetUserId = interaction.customId.slice(IDS.welcome.length + 1);
    if (targetUserId && interaction.user.id !== targetUserId) {
      return ephemeral(interaction, '⛔ Ce bouton ne vous est pas destiné.');
    }

    return ephemeral(
      interaction,
      '👋 **Bienvenue sur le serveur du TP !**\n\n' +
        'Pour participer au TP de manière propre :\n' +
        '1️⃣ Ouvre le **chat textuel du salon vocal** (ou le salon de la file).\n' +
        '2️⃣ Clique sur **"✋ Rejoindre la file"** uniquement quand ton travail est prêt.\n' +
        '3️⃣ Remplis ton **Nom**, **Prénom** et ton **Groupe** (1, 2 ou 3).\n' +
        '4️⃣ Lorsque ton nom passe en 🟢 **En cours**, active ton partage d’écran dans le vocal !\n\n' +
        '*Bon TP ! 🚀*'
    );
  }

  /**
   * Point d'entrée unique — une seule écoute pour toutes les interactions.
   *
   * @param {import('discord.js').Interaction} interaction
   */
  async function handle(interaction) {
    try {
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'tp-start') return await handleStart(interaction);
        return undefined;
      }

      if (interaction.isModalSubmit()) {
        if (interaction.customId === IDS.modalJoin) return await handleJoinModal(interaction);
        return undefined;
      }

      if (!interaction.isButton()) return undefined;

      // Les boutons de bienvenue ne dépendent pas du panneau : à traiter avant.
      if (interaction.customId.startsWith(`${IDS.welcome}_`) || interaction.customId === IDS.welcome) {
        return await handleWelcomeButton(interaction);
      }

      if (await rejectStaleBoard(interaction)) return undefined;

      switch (interaction.customId) {
        case IDS.join:
          return await handleJoinButton(interaction);
        case IDS.fixed:
          return await handleFixed(interaction);
        case IDS.leave:
          return await handleLeave(interaction);
        case IDS.next:
          return await handleNext(interaction);
        case IDS.sendFix:
          return await handleSendFix(interaction);
        default:
          return undefined;
      }
    } catch (error) {
      logger.error('Interaction non gérée', {
        customId: /** @type {any} */ (interaction).customId,
        error: error?.message ?? error,
      });

      if (!interaction.isRepliable?.() || interaction.replied || interaction.deferred) {
        return undefined;
      }
      return ephemeral(interaction, '❌ Une erreur interne est survenue.');
    }
  }

  return { handle, render };
}

/**
 * Message affiché quand l'étudiant est déjà quelque part.
 *
 * @param {import('./queue-store').EntryLocation} location
 */
function alreadyQueuedMessage(location) {
  switch (location) {
    case 'current':
      return '⚠️ Tu es déjà en train de passer.';
    case 'priority':
      return '⚠️ Tu es déjà dans la file de rectification.';
    case 'fixing':
      return '⚠️ Tu es déjà en rectification.';
    default:
      return '⚠️ Tu es déjà inscrit dans la file.';
  }
}

/** Définition de la commande slash, partagée avec `src/deploy-commands.js`. */
function commandDefinitions() {
  return [
    new SlashCommandBuilder()
      .setName('tp-start')
      .setDescription('Lance la file d’attente propre dans ce salon'),
  ].map((command) => command.toJSON());
}

/**
 * Enregistre les commandes slash (idempotent).
 *
 * @param {{ rest: import('discord.js').REST, clientId: string, logger: import('./env').Logger }} options
 */
async function registerCommands({ rest, clientId, logger }) {
  const body = commandDefinitions();
  await rest.put(Routes.applicationCommands(clientId), { body });
  logger.info('Commandes slash enregistrées.', { count: body.length });
  return body;
}

/**
 * Message de bienvenue (`guildMemberAdd`).
 *
 * @param {{
 *   member: import('discord.js').GuildMember,
 *   config: ReturnType<typeof import('./env').createConfig>,
 *   logger: import('./env').Logger,
 * }} options
 */
async function sendWelcome({ member, config, logger }) {
  try {
    const channel = config.welcomeChannelId
      ? member.guild.channels.cache.get(config.welcomeChannelId) ??
        (await member.guild.channels.fetch(config.welcomeChannelId).catch(() => null))
      : member.guild.channels.cache.find(
          (candidate) =>
            candidate.name?.includes('bienvenue') || candidate.name?.includes('accueil')
        );

    if (!channel || !channel.isTextBased?.()) return;

    const embed = new EmbedBuilder()
      .setTitle(`Bienvenue, ${member.user.username} ! 🎓`)
      .setDescription(
        'Bienvenue sur le serveur du TP.\n\n' +
          'Pour voir les instructions en privé, clique sur le bouton ci-dessous 👇'
      )
      .setColor(0x5865f2)
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${IDS.welcome}_${member.id}`)
        .setLabel('📖 Voir mon guide d’accueil')
        .setStyle(ButtonStyle.Primary)
    );

    await channel.send({
      content: `<@${member.id}>`,
      embeds: [embed],
      components: [row],
    });
  } catch (error) {
    logger.error('Message de bienvenue impossible', { error: error?.message ?? error });
  }
}

module.exports = {
  EPHEMERAL,
  REST,
  alreadyQueuedMessage,
  commandDefinitions,
  createInteractionHandler,
  isExpiredInteraction,
  registerCommands,
  sendWelcome,
};
