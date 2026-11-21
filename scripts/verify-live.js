'use strict';

/**
 * Vérification en conditions réelles, contre l'API Discord.
 *
 * Contrairement aux tests unitaires (faux client), ce script :
 *   - se connecte vraiment avec le token ;
 *   - crée un salon temporaire dans un serveur de test ;
 *   - publie un vrai panneau et l'édite avec la vraie API ;
 *   - mesure la latence réelle et compte les vrais 429 via les événements REST.
 *
 * Ce qu'il NE peut pas tester : le clic d'un vrai utilisateur. Un token
 * d'interaction ne peut pas être fabriqué. Le mode `--interactive` te laisse
 * cliquer à la main pour couvrir ce dernier maillon.
 *
 * Sécurité : refuse de tourner sans GUILD_ID explicite, utilise un salon
 * temporaire, et supprime tout ce qu'il a créé.
 *
 *   node scripts/verify-live.js --dry-run     # valide token + permissions
 *   node scripts/verify-live.js --yes         # vérification automatique
 *   node scripts/verify-live.js --interactive # clics manuels
 */

const fs = require('node:fs');
const readline = require('node:readline/promises');
const { performance } = require('node:perf_hooks');

const {
  Client,
  GatewayIntentBits,
  ChannelType,
  PermissionFlagsBits,
  RESTEvents,
  Events,
} = require('discord.js');

const { loadDotEnv, createConfig, createLogger, missingRequired } = require('../src/env');
const { createBoard } = require('../src/board');
const { QueueStore } = require('../src/queue-store');
const { buildPanelPayload } = require('../src/panel');

loadDotEnv();

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const CONFIRMED = argv.includes('--yes');
const INTERACTIVE = argv.includes('--interactive');
const KEEP = argv.includes('--no-cleanup');

const config = createConfig();
const logger = createLogger(argv.includes('--verbose') ? 'debug' : 'info');

const STUDENTS = Number.parseInt(process.env.VERIFY_STUDENTS ?? '50', 10);

/** Résultats collectés au fil de l'exécution. */
const report = {
  account: null,
  guild: null,
  channel: null,
  studentsRegistered: 0,
  panelEdits: 0,
  rateLimitHits: 0,
  /** @type {number[]} */
  editLatenciesMs: [],
  restRequests: 0,
  errors: /** @type {string[]} */ ([]),
};

/**
 * Affiche une étape.
 *
 * @param {string} message
 */
function step(message) {
  console.log(`\n▸ ${message}`);
}

/**
 * Affiche un résultat.
 *
 * @param {boolean} ok
 * @param {string} message
 */
function check(ok, message) {
  console.log(`  ${ok ? '✅' : '❌'} ${message}`);
  if (!ok) report.errors.push(message);
  return ok;
}

function fail(message) {
  console.error(`\n❌ ${message}\n`);
  process.exit(1);
}

/**
 * Attend la fin de la boucle d'événements (le client discord.js est prêt).
 *
 * @param {Client} client
 */
function waitReady(client) {
  if (client.isReady()) return Promise.resolve();
  return new Promise((resolve) => client.once(Events.ClientReady, () => resolve()));
}

/**
 * Supprime le salon temporaire et le fichier d'état.
 *
 * @param {Client} client
 */
async function cleanup(client) {
  if (KEEP) {
    console.log('\n▸ Nettoyage ignoré (--no-cleanup) : le salon de test est conservé.');
    return;
  }

  if (report.channel) {
    try {
      const channel = await client.channels.fetch(report.channel.id).catch(() => null);
      if (channel) await channel.delete('Vérification PQB terminée');
      console.log('\n▸ Salon de test supprimé.');
    } catch (error) {
      console.warn(`  ⚠️ Suppression du salon impossible : ${error.message}`);
    }
  }
}

/**
 * Point d'entrée.
 */
async function main() {
  // --- 1. Configuration --------------------------------------------------
  step('Configuration');

  const missing = missingRequired(config);
  if (missing.length > 0) {
    fail(
      `Variables manquantes : ${missing.join(', ')}\n` +
        '   Crée un fichier .env (jamais commité) avec DISCORD_TOKEN et DISCORD_CLIENT_ID,\n' +
        '   plus GUILD_ID pour le serveur de test. Voir .env.example.'
    );
  }

  if (!config.guildIdForVerify) {
    fail(
      'GUILD_ID manquant.\n' +
        '   Par sécurité, le script refuse de deviner sur quel serveur travailler.\n' +
        '   Ajoute GUILD_ID=<id du serveur de test> dans .env.'
    );
  }

  check(true, `Token présent (${config.token.length} caractères)`);
  check(true, `Serveur cible : ${config.guildIdForVerify}`);
  check(true, `${STUDENTS} étudiants simulés`);
  check(true, `Mode : ${INTERACTIVE ? 'interactif' : DRY_RUN ? 'dry-run' : 'automatique'}`);

  // --- 2. Connexion ------------------------------------------------------
  step('Connexion à Discord');

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  });

  // Compteur de 429 réels remontés par la couche REST de discord.js.
  client.rest.on(RESTEvents.RateLimited, (info) => {
    report.rateLimitHits += 1;
    logger.warn('429 réel reçu de Discord', {
      route: info?.route,
      retryAfter: info?.retryAfter,
      global: info?.global,
    });
  });

  client.rest.on(RESTEvents.Response, () => {
    report.restRequests += 1;
  });

  client.on(Events.Error, (error) => {
    logger.error('Erreur client', { error: error?.message ?? error });
  });

  try {
    await client.login(config.token);
    await waitReady(client);
  } catch (error) {
    fail(
      `Connexion impossible : ${error?.message ?? error}\n` +
        '   Un token invalide donne "An invalid token was provided".\n' +
        '   Vérifie aussi que l\'intent GuildMembers est activé sur le portail développeur.'
    );
  }

  report.account = { id: client.user.id, tag: client.user.tag };
  check(true, `Connecté : ${client.user.tag}`);
  check(client.guilds.cache.size > 0, `${client.guilds.cache.size} serveur(s) accessible(s)`);

  // --- 3. Serveur --------------------------------------------------------
  step('Résolution du serveur');

  const guild = await client.guilds.fetch(config.guildIdForVerify).catch(() => null);
  if (!guild) {
    await cleanup(client);
    fail(`Serveur ${config.guildIdForVerify} introuvable. Le bot y est-il invité ?`);
  }

  report.guild = { id: guild.id, name: guild.name };
  check(true, `Serveur : ${guild.name}`);

  const me = await guild.members.fetchMe();
  const canManage = me.permissions.has(PermissionFlagsBits.ManageChannels);
  const canSend = me.permissions.has(PermissionFlagsBits.SendMessages);
  check(canManage, 'Permission « Gérer les salons » (salon temporaire)');
  check(canSend, 'Permission « Envoyer des messages »');

  if (!canManage || !canSend) {
    await cleanup(client);
    fail('Permissions insuffisantes pour la vérification.');
  }

  if (DRY_RUN) {
    step('Dry-run terminé');
    console.log('  Tout est prêt. Relance sans --dry-run pour la vérification complète.\n');
    client.destroy();
    process.exit(report.errors.length === 0 ? 0 : 1);
  }

  if (!CONFIRMED && !INTERACTIVE) {
    console.log('\n▸ Ce test va créer un salon temporaire et y publier un panneau.');
    console.log('  Relance avec --yes pour confirmer.\n');
    client.destroy();
    process.exit(0);
  }

  // --- 4. Salon temporaire ----------------------------------------------
  step('Création du salon temporaire');

  const channel = await guild.channels.create({
    name: `pqb-verif-${Date.now().toString(36).slice(-6)}`,
    type: ChannelType.GuildText,
    topic: 'Vérification automatique PQB — ce salon sera supprimé',
    reason: 'Vérification PQB',
  });

  report.channel = { id: channel.id, name: channel.name };
  check(true, `Salon créé : #${channel.name}`);

  // --- 5. Panneau réel ---------------------------------------------------
  step('Publication du panneau');

  const store = new QueueStore({ maxQueueLength: 1000 });

  const board = createBoard({
    getClient: () => client,
    store,
    logger,
    minIntervalMs: 1500,
    render: (snapshot) => buildPanelPayload(snapshot, { pageSize: config.queuePageSize }),
  });

  const published = await board.publish(channel);
  check(true, `Panneau publié (id ${published.id})`);
  check(
    published.editable !== false,
    'Le panneau appartient au bot (il pourra l’éditer)'
  );

  // --- 6. Mode interactif ------------------------------------------------
  if (INTERACTIVE) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    console.log('\n▸ MODE INTERACTIF');
    console.log('  Le panneau est en ligne. Depuis Discord :');
    console.log('   1. Clique sur « ✋ Rejoindre la file » et remplis le formulaire (3 fois)');
    console.log('   2. Demande à un profil Prof/Délégué de cliquer « ▶️ Suivant »');
    console.log('   3. Essaie ensuite avec 20+ inscriptions pour le cas de charge');
    console.log('\n  Puis reviens ici et appuie sur Entrée.');
    await rl.question('\n  Entrée quand tu as terminé… ');
    rl.close();

    const finalMessage = await channel.messages.fetch(published.id);
    const embed = finalMessage.embeds[0];
    const fifoField = embed?.fields?.[2];

    step('État du panneau après tes clics');
    check(!!embed, 'L’embed est toujours présent');
    check(
      (fifoField?.value.length ?? 0) <= 1024,
      `Champ FIFO valide (${fifoField?.value.length ?? 0} / 1024 caractères)`
    );
    console.log(`\n  Contenu :\n${embed?.fields?.map((f) => `   ${f.name}\n   ${f.value.replace(/\n/g, '\n   ')}`).join('\n\n') ?? '(vide)'}`);
    console.log(`\n  Requêtes REST : ${report.restRequests}`);
    console.log(`  429 réels : ${report.rateLimitHits}\n`);

    board.dispose();
    await cleanup(client);
    client.destroy();
    process.exit(report.errors.length === 0 ? 0 : 1);
  }

  // --- 7. Charge réelle --------------------------------------------------
  step(`${STUDENTS} inscriptions simultanées (vraies éditions API)`);

  const startedAt = performance.now();

  for (let index = 0; index < STUDENTS; index += 1) {
    store.join({
      discordId: `verify${index}`,
      nom: 'Benali',
      prenom: 'Yacine',
      groupe: '1',
    });
    // Exactement ce que fait le handler après une inscription.
    board.invalidate();
  }

  await board.settle();

  const chargeMs = Math.round(performance.now() - startedAt);

  report.studentsRegistered = store.normal.size;
  report.panelEdits = board.stats.edits;
  report.editLatenciesMs = [Math.round(chargeMs)];

  check(report.studentsRegistered === STUDENTS, `${report.studentsRegistered}/${STUDENTS} étudiants enregistrés`);
  check(
    report.panelEdits <= 3,
    `${report.panelEdits} édition(s) du panneau pour ${STUDENTS} inscriptions (attendu ≤ 3)`
  );
  check(report.rateLimitHits === 0, `${report.rateLimitHits} rate limit(s) 429 réel(s)`);

  // --- 8. Vérification du message réel -----------------------------------
  step('Relecture du message publié sur Discord');

  const fetched = await channel.messages.fetch(published.id);
  const embed = fetched.embeds[0];
  const json = embed?.toJSON();
  const fifo = json?.fields?.find((field) => field.name.includes('FIFO'));

  check(!!embed, 'Le message contient bien un embed');
  check(
    (fifo?.value.length ?? Infinity) <= 1024,
    `Champ FIFO sous la limite Discord (${fifo?.value.length ?? 0} / 1024)`
  );
  check(
    (fifo?.value ?? '').includes('et'),
    'La ligne de dépassement « … et N autres » est affichée'
  );
  check(
    (json?.fields?.length ?? 0) === 4,
    `4 sections présentes (${json?.fields?.length ?? 0})`
  );

  console.log(`\n  Aperçu de la file :\n${(fifo?.value ?? '').split('\n').map((l) => `   ${l}`).join('\n')}`);

  // --- 9. Contrôle du code d'origine -------------------------------------
  step('Contrôle : le code d’origine échouerait-il ?');
  console.log(`  (vérification locale, aucun appel API)`);

  const { EmbedBuilder } = require('discord.js');
  const legacyLines = Array.from(
    { length: STUDENTS },
    (_, i) => `**${i + 1}.** **Benali Yacine** (G1)`
  ).join('\n');

  let legacyOk = true;
  try {
    new EmbedBuilder()
      .setTitle('File d’attente TP')
      .addFields(
        { name: 'a', value: 'x' },
        { name: 'b', value: 'x' },
        { name: 'FIFO', value: legacyLines },
        { name: 'd', value: 'x' }
      );
  } catch {
    legacyOk = false;
  }

  check(
    legacyOk === false,
    legacyOk
      ? `Le code d’origine tiendrait à ${STUDENTS} étudiants (revérifier les chiffres)`
      : `Le code d’origine aurait planté à ${STUDENTS} étudiants (${legacyLines.length} caractères)`
  );

  // --- 10. Bilan ---------------------------------------------------------
  step('Bilan');

  console.log(`  Compte            : ${report.account.tag}`);
  console.log(`  Serveur           : ${report.guild.name}`);
  console.log(`  Requêtes REST     : ${report.restRequests}`);
  console.log(`  Éditions panneau  : ${report.panelEdits}`);
  console.log(`  429 réels         : ${report.rateLimitHits}`);
  console.log(`  Durée du pic      : ${chargeMs} ms`);

  const ok = report.errors.length === 0;

  console.log('');
  console.log(
    ok
      ? '✅ Vérification en conditions réelles réussie.'
      : `❌ ${report.errors.length} contrôle(s) en échec.`
  );
  console.log('');

  board.dispose();
  await cleanup(client);
  client.destroy();
  process.exit(ok ? 0 : 1);
}

main().catch(async (error) => {
  console.error('\n❌ Échec inattendu :', error?.stack ?? error);
  process.exit(1);
});
