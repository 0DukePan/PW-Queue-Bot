const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  SlashCommandBuilder,
  REST,
  Routes,
} = require('discord.js');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;

if (!TOKEN || !CLIENT_ID) {
  throw new Error('Set DISCORD_TOKEN and DISCORD_CLIENT_ID in the environment.');
}

// Rôles staff restreints uniquement à Prof et Délégué
const STAFF_ROLES = ['Prof', 'Délégué'];

const client = new Client({ 
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ] 
});

// Stockage unique de la file
let queueState = {
  current: null,       // { discordId, nom, prenom, groupe, isPriority }
  priorityQueue: [],   // [{ discordId, nom, prenom, groupe, priorityAt }]
  normalQueue: [],     // [{ discordId, nom, prenom, groupe, joinedAt }]
  fixing: new Map(),   // Map<discordId, { nom, prenom, groupe }>
};

function isStaff(member) {
  return member.roles.cache.some((r) => STAFF_ROLES.includes(r.name));
}

function buildEmbed() {
  const currentText = queueState.current
    ? `🟢 **${queueState.current.nom} ${queueState.current.prenom}** (Groupe ${queueState.current.groupe}) — <@${queueState.current.discordId}> ${queueState.current.isPriority ? '*(Retour rectification)*' : ''}`
    : '*Aucun étudiant en cours de passage*';

  const prioText =
    queueState.priorityQueue.length > 0
      ? queueState.priorityQueue
          .map(
            (u, i) =>
              `**${i + 1}.** ⚡ **${u.nom} ${u.prenom}** (G${u.groupe})`
          )
          .join('\n')
      : '*Vide*';

  const normalText =
    queueState.normalQueue.length > 0
      ? queueState.normalQueue
          .map(
            (u, i) =>
              `**${i + 1}.** **${u.nom} ${u.prenom}** (G${u.groupe})`
          )
          .join('\n')
      : '*Vide*';

  const fixingText =
    queueState.fixing.size > 0
      ? Array.from(queueState.fixing.values())
          .map((u) => `🛠️ **${u.nom} ${u.prenom}** (G${u.groupe})`)
          .join(', ')
      : '*Aucun*';

  return new EmbedBuilder()
    .setTitle('File d’attente TP')
    .setColor(0x5865f2)
    .addFields(
      { name: '🎙️ En partage d’écran (Salon Vocal)', value: currentText },
      { name: '⚡ File de Rectifications', value: prioText },
      { name: '⏳ File d’attente (FIFO)', value: normalText },
      { name: '🔧 En cours d’ajustement (Rectification)', value: fixingText }
    )
    .setFooter({ text: 'Système propre sans spam — Regardez le statut ci-dessus' })
    .setTimestamp();
}

function buildButtons() {
  const studentRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('tp_join_modal')
      .setLabel('✋ Rejoindre la file')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('tp_fixed')
      .setLabel('⚡ Rectification finie')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('tp_leave')
      .setLabel('❌ Quitter la file')
      .setStyle(ButtonStyle.Secondary)
  );

  const staffRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('tp_next')
      .setLabel('▶️ Suivant (Prof/Délégué)')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('tp_send_fix')
      .setLabel('↺ Renvoyer en rectification')
      .setStyle(ButtonStyle.Danger)
  );

  return [studentRow, staffRow];
}

client.once('ready', async () => {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const commands = [
    new SlashCommandBuilder()
      .setName('tp-start')
      .setDescription('Lance la file d’attente propre dans ce salon'),
  ].map((c) => c.toJSON());

  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log(`Bot prêt : ${client.user.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  // 1. Commande /tp-start
  if (interaction.isChatInputCommand() && interaction.commandName === 'tp-start') {
    if (!isStaff(interaction.member)) {
      return interaction.reply({ content: '⛔ Réservé au Prof ou aux Délégués.', ephemeral: true });
    }
    queueState = { current: null, priorityQueue: [], normalQueue: [], fixing: new Map() };
    return interaction.reply({
      embeds: [buildEmbed()],
      components: buildButtons(),
    });
  }

  // 2. Gestion du message d'accueil privé (Éphémère)
  if (interaction.isButton() && interaction.customId.startsWith('welcome_private_')) {
    const targetUserId = interaction.customId.split('_')[2];
    if (interaction.user.id !== targetUserId) {
      return interaction.reply({ content: '⛔ Ce bouton ne vous est pas destiné.', ephemeral: true });
    }

    return interaction.reply({
      content: 
        `👋 **Bienvenue sur le serveur du TP !**\n\n` +
        `Pour participer au TP de manière propre :\n` +
        `1️⃣ Ouvre le **chat textuel du salon vocal** (ou le salon de la file).\n` +
        `2️⃣ Clique sur **"✋ Rejoindre la file"** uniquement quand ton travail est prêt.\n` +
        `3️⃣ Remplis ton **Nom**, **Prénom** et ton **Groupe** (1, 2 ou 3).\n` +
        `4️⃣ Lorsque ton nom passe en vert 🟢 **En cours**, active ton partage d'écran dans le vocal !\n\n` +
        `*Bon TP ! 🚀*`,
      ephemeral: true,
    });
  }

  // 3. Clic sur "Rejoindre" -> Ouvre le formulaire
  if (interaction.isButton() && interaction.customId === 'tp_join_modal') {
    const userId = interaction.user.id;
    const alreadyIn =
      queueState.current?.discordId === userId ||
      queueState.priorityQueue.some((u) => u.discordId === userId) ||
      queueState.normalQueue.some((u) => u.discordId === userId) ||
      queueState.fixing.has(userId);

    if (alreadyIn) {
      return interaction.reply({ content: '⚠️ Tu es déjà inscrit dans la file ou en rectification.', ephemeral: true });
    }

    const modal = new ModalBuilder()
      .setCustomId('tp_modal_join')
      .setTitle('Informations Étudiant - TP');

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('nom').setLabel('Nom').setStyle(TextInputStyle.Short).setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('prenom').setLabel('Prénom').setStyle(TextInputStyle.Short).setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('groupe').setLabel('Groupe (1, 2 ou 3)').setStyle(TextInputStyle.Short).setMaxLength(1).setRequired(true)
      )
    );

    return interaction.showModal(modal);
  }

  // 4. Soumission du formulaire (Modal Submit) -> Réponse 100% éphémère (invisible pour les autres)
  if (interaction.isModalSubmit() && interaction.customId === 'tp_modal_join') {
    const nom = interaction.fields.getTextInputValue('nom').trim();
    const prenom = interaction.fields.getTextInputValue('prenom').trim();
    const groupe = interaction.fields.getTextInputValue('groupe').trim();

    if (!['1', '2', '3'].includes(groupe)) {
      return interaction.reply({ content: '❌ Groupe invalide. Indiquez 1, 2 ou 3.', ephemeral: true });
    }

    queueState.normalQueue.push({
      discordId: interaction.user.id,
      nom,
      prenom,
      groupe,
      joinedAt: Date.now(),
    });

    const message = interaction.message;
    if (message) {
      await message.edit({ embeds: [buildEmbed()], components: buildButtons() });
    }

    // Confirmation invisible (ephemeral) pour ne pas polluer le chat
    return interaction.reply({ content: `✅ Inscription validée (${nom} ${prenom} - G${groupe}). Regarde le tableau de la file !`, ephemeral: true });
  }

  if (!interaction.isButton()) return;

  const userId = interaction.user.id;

  // 5. Étudiant a fini sa rectification
  if (interaction.customId === 'tp_fixed') {
    if (!queueState.fixing.has(userId)) {
      return interaction.reply({ content: '⛔ Tu n’es pas marqué en rectification.', ephemeral: true });
    }
    const studentData = queueState.fixing.get(userId);
    queueState.fixing.delete(userId);
    queueState.priorityQueue.push({ ...studentData, priorityAt: Date.now() });

    await interaction.update({ embeds: [buildEmbed()], components: buildButtons() });
    return;
  }

  // 6. Quitter la file
  if (interaction.customId === 'tp_leave') {
    queueState.normalQueue = queueState.normalQueue.filter((u) => u.discordId !== userId);
    queueState.priorityQueue = queueState.priorityQueue.filter((u) => u.discordId !== userId);
    queueState.fixing.delete(userId);

    await interaction.update({ embeds: [buildEmbed()], components: buildButtons() });
    return;
  }

  // 7. Actions Prof / Délégué (Suivant / Rectification) -> SANS SPAM DE TEXTE
  if (interaction.customId === 'tp_next' || interaction.customId === 'tp_send_fix') {
    if (!isStaff(interaction.member)) {
      return interaction.reply({ content: '⛔ Action réservée au Prof ou aux Délégués.', ephemeral: true });
    }

    if (interaction.customId === 'tp_send_fix') {
      if (!queueState.current) {
        return interaction.reply({ content: '⚠️ Aucun étudiant en cours de passage.', ephemeral: true });
      }
      queueState.fixing.set(queueState.current.discordId, queueState.current);
      queueState.current = null;
    }

    let nextStudent = null;
    if (queueState.priorityQueue.length > 0) {
      nextStudent = queueState.priorityQueue.shift();
      nextStudent.isPriority = true;
    } else if (queueState.normalQueue.length > 0) {
      nextStudent = queueState.normalQueue.shift();
      nextStudent.isPriority = false;
    }

    queueState.current = nextStudent;

    // Met à jour le message unique de manière propre, sans aucun message de texte additionnel
    return interaction.update({ embeds: [buildEmbed()], components: buildButtons() });
  }
});

// --- MESSAGE DE BIENVENUE AUTOMATIQUE ---
client.on('guildMemberAdd', async (member) => {
  try {
    const welcomeChannel = member.guild.channels.cache.find(
      (channel) => channel.name.includes('bienvenue') || channel.name.includes('accueil')
    );

    if (!welcomeChannel) return;

    const welcomeEmbed = new EmbedBuilder()
      .setTitle(`Bienvenue, ${member.user.username} ! 🎓`)
      .setDescription(
        `Bienvenue sur le serveur du TP.\n\n` +
        `Pour voir les instructions en privé, clique sur le bouton ci-dessous 👇`
      )
      .setColor(0x5865f2)
      .setTimestamp();

    const welcomeButton = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`welcome_private_${member.id}`)
        .setLabel('📖 Voir mon guide d’accueil')
        .setStyle(ButtonStyle.Primary)
    );

    await welcomeChannel.send({
      content: `<@${member.id}>`,
      embeds: [welcomeEmbed],
      components: [welcomeButton],
    });
  } catch (error) {
    console.error('Erreur lors du message de bienvenue :', error);
  }
});

client.login(TOKEN);