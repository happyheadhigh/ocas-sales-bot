'use strict';

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits,
  ChannelSelectMenuBuilder, RoleSelectMenuBuilder, StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder, ChannelType, MessageFlags,
} = require('discord.js');

const { OWNER_DISCORD_IDS } = require('../lib/constants');
const { buildRolePickerRows } = require('../lib/role-picker');
const {
  initSession: initValuePicker, getSession: getValuePickerSession, clearSession: clearValuePicker,
  buildStackedValuePickerRows, recordMenuSelection, parseValuePickerCustomId,
} = require('../lib/value-picker');

const OCAS_CONTRACT = '0x078be86f3104a32313a47815792230a3808642cc';

// ── Access control ────────────────────────────────────────────────────────────
// Same gate as /config: Manage Server permission, or the guild's configured
// Bot Manager role (set via /config → Access). Checked in code, not just at
// slash-command registration, since registration-level permissions can be
// loosened by server admins via Discord's own Integrations settings.
function hasSetupAccess(interaction, cfg){
  if(OWNER_DISCORD_IDS.has(String(interaction.user.id))) return true;
  if(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  const managerRoleId = cfg?.botManagerRoleId;
  if(managerRoleId && interaction.member?.roles?.cache?.has(managerRoleId)) return true;
  return false;
}
const SETUP_NO_ACCESS_MSG = '🔒 You need **Manage Server** permission or the designated Bot Manager role to use this.';
const OCAS_SLUG     = 'on-chain-all-stars';

// Trait cache — canonical implementation in lib/db.js (includes dedup check).
const { fetchAndStoreCollectionTraits } = require('../lib/db');

// ── Wizard state ──────────────────────────────────────────────────────────────
// In-memory cache; backed by server_configs JSONB (wizard_state key) for persistence
const wizardCache = new Map(); // guildId → { step, config }

async function loadState(guildId, pgPool){
  if(wizardCache.has(guildId)) return wizardCache.get(guildId);
  try{
    const r = await pgPool.query(`SELECT config FROM server_configs WHERE guild_id=$1`, [guildId]);
    const saved = r.rows[0]?.config?.wizard_state;
    if(saved){ wizardCache.set(guildId, saved); return saved; }
  }catch(_){}
  const fresh = { step: 1, config: {} };
  wizardCache.set(guildId, fresh);
  return fresh;
}

async function saveState(guildId, state, pgPool){
  wizardCache.set(guildId, state);
  try{
    await pgPool.query(
      `INSERT INTO server_configs(guild_id, config) VALUES($1, jsonb_build_object('wizard_state',$2::jsonb))
       ON CONFLICT(guild_id) DO UPDATE SET config = server_configs.config || jsonb_build_object('wizard_state',$2::jsonb)`,
      [guildId, JSON.stringify(state)]
    );
  }catch(e){ console.warn('[Setup] saveState:', e.message); }
}

async function clearWizardState(guildId, pgPool){
  wizardCache.delete(guildId);
  try{
    await pgPool.query(
      `UPDATE server_configs SET config = config - 'wizard_state' WHERE guild_id=$1`,
      [guildId]
    );
  }catch(_){}
}

// ── Step UI helpers ───────────────────────────────────────────────────────────
function stepBar(current, total){
  return '█'.repeat(current) + '░'.repeat(total - current) + `  Step ${current} of ${total}`;
}
const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';

// ── Step embeds ───────────────────────────────────────────────────────────────
function buildWelcomeEmbed(){
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🤖 Bot Setup Wizard')
    .setDescription(
      SEP + '\n\n' +
      'Welcome! This wizard will walk you through setting up your bot.\n\n' +
      '**What we\'ll configure:**\n' +
      '→ Your NFT collection\n' +
      '→ Sales & listings channels\n' +
      '→ Wallet verification & holder roles *(optional)*\n' +
      '→ Trait-based roles (optional)\n\n' +
      '*You can run `/setup` anytime to update settings.*'
    )
    .setFooter({ text: 'Only visible to you' });
}

function buildCollectionEmbed(state){
  const cfg = state.config;
  const hasC = !!cfg.contract;
  const slugLine = cfg.collectionSlug ? `🔗 **Slug:** \`${cfg.collectionSlug}\`\n` : '⚠️ **Slug:** Not set — trait search & token thumbnails won\'t work\n';
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('📦 Collection')
    .setDescription(
      stepBar(2, 6) + '\n' + SEP + '\n\n' +
      'Enter your NFT contract address and OpenSea collection slug.\n\n' +
      (hasC
        ? `✅ **Contract:** \`${cfg.contract}\`\n` +
          (cfg.isOcas ? '🔥 **OCAS detected** — full feature set unlocked!\n' : `📁 **Name:** ${cfg.contractName || 'Custom collection'}\n` + slugLine)
        : '❌ No contract set yet.\n') +
      '\n*Find the slug in your OpenSea collection URL: opensea.io/collection/**your-slug***'
    )
    .setFooter({ text: 'Only visible to you' });
}

function buildChannelsEmbed(state){
  const cfg = state.config;
  const isOcas = cfg.contract?.toLowerCase() === OCAS_CONTRACT;
  const ch = id => id ? `<#${id}> ✅` : '❌ Not set';
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('📡 Alert Channels')
    .setDescription(
      stepBar(3, 6) + '\n' + SEP + '\n\n' +
      'Choose which channels the bot posts alerts in.\n\n' +
      `🟢 **Sales:** ${ch(cfg.salesChannel)}\n` +
      `📋 **Listings:** ${ch(cfg.listingsChannel)}\n` +
      (isOcas ? `🔥 **Burn Alerts:** ${ch(cfg.burnChannel)}\n` : '') +
      '\n*You can skip any channel — alerts just won\'t post there.*'
    )
    .setFooter({ text: 'Only visible to you' });
}

function buildVerificationEmbed(state){
  const cfg = state.config;
  const configured = !!(cfg.verifyChannel && cfg.verifyRole);
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🔐 Wallet Verification')
    .setDescription(
      stepBar(4, 6) + '\n' + SEP + '\n\n' +
      'Any member can link their wallet — no token required.\n' +
      'Members who hold ≥1 token also get the **Holder** role automatically.\n\n' +
      `📌 **Channel:** ${cfg.verifyChannel ? `<#${cfg.verifyChannel}> ✅` : '❌ Not set'}\n` +
      `✅ **Verified Role:** ${cfg.verifyRole ? `<@&${cfg.verifyRole}> ✅` : '❌ Not set'}\n` +
      `🏆 **Holder Role:** ${cfg.holderRole ? `<@&${cfg.holderRole}> ✅` : '⚪ Optional'}\n\n` +
      (configured
        ? '✅ Ready to deploy verification panel.'
        : '*Don\'t need verification? No problem — skip this step and click Next. Your alerts (sales, listings, burns) work completely fine without it.*')
    )
    .setFooter({ text: 'Only visible to you' });
}

// Trait roles saved from the wizard always use collection_slug IS NULL (the
// "primary" collection slot — same as /config's default view), so a role
// added here or later via /config shows up together, not in two separate lists.
async function fetchWizardTraitRoles(guildId, pgPool){
  try{
    const r = await pgPool.query(
      `SELECT id, trait_type, trait_value, role_id, minimum_count FROM trait_roles
       WHERE guild_id=$1 AND collection_slug IS NULL ORDER BY trait_type, trait_value`,
      [guildId]
    );
    return r.rows;
  }catch(e){ console.warn('[Setup] fetchWizardTraitRoles:', e.message); return []; }
}
function traitRuleLabel(r){
  if(r.trait_type === '_count') return `Own ${r.minimum_count}+ tokens`;
  if(r.trait_type === '_totalburns') return `${r.minimum_count}+ burn transactions, ever`;
  if(r.trait_type === '_maxburn') return `${r.minimum_count}+ tokens in a single burn`;
  return `${r.trait_type}: ${r.trait_value || 'any'}${r.minimum_count > 1 ? ` ×${r.minimum_count}` : ''}`;
}

function buildTraitRolesEmbed(state, roles){
  const cfg = state.config;
  roles = roles || [];

  let roleList = '';
  if(roles.length === 0){
    roleList = '*No trait roles configured yet.*\n';
  } else {
    roleList = roles.map((r, i) =>
      `**${i+1}.** <@&${r.role_id}> — ${traitRuleLabel(r)}`
    ).join('\n') + '\n';
  }

  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🎭 Trait Roles')
    .setDescription(
      stepBar(5, 6) + '\n' + SEP + '\n\n' +
      'Automatically assign roles based on what tokens a member holds.\n\n' +
      '**Configured roles:**\n' + roleList + '\n' +
      '**How it works:**\n' +
      '→ Member verifies → bot checks their tokens & traits\n' +
      '→ Matching roles assigned instantly, re-synced every 24h\n\n' +
      '**Examples:** Own a Zombie → `@Zombie Holder` · Own 20+ → `@Whale`'
    )
    .setFooter({ text: 'Only visible to you — manage trait roles anytime with /config' });
}

function buildSummaryEmbed(state, guild, roles){
  const cfg = state.config;
  const isOcas = cfg.contract?.toLowerCase() === OCAS_CONTRACT;
  const ch  = id => id ? `<#${id}>` : 'Not set';
  const rol = id => id ? `<@&${id}>` : 'Not set';
  const tick = v => v ? '✅' : '❌';
  roles = roles || [];

  return new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle('✅ Setup Complete!')
    .setDescription(
      SEP + '\n\n' +
      `📦 **Collection:** ${isOcas ? 'On-Chain All Stars 🔥' : (cfg.contractName || 'Custom')} ${tick(cfg.contract)}\n` +
      `🟢 **Sales Channel:** ${ch(cfg.salesChannel)} ${tick(cfg.salesChannel)}\n` +
      `📋 **Listings Channel:** ${ch(cfg.listingsChannel)} ${tick(cfg.listingsChannel)}\n` +
      (isOcas ? `🔥 **Burn Alerts:** ${ch(cfg.burnChannel)} ${tick(cfg.burnChannel)}\n` : '') +
      `📌 **Verification Channel:** ${ch(cfg.verifyChannel)} ${tick(cfg.verifyChannel)}\n` +
      `✅ **Verified Role:** ${rol(cfg.verifyRole)} ${tick(cfg.verifyRole)}\n` +
      `🏆 **Holder Role:** ${cfg.holderRole ? rol(cfg.holderRole) + ' ✅' : '⚪ Not set'}\n` +
      `🎭 **Trait Roles:** ${roles.length} configured\n\n` +
      SEP + '\n' +
      '**What happens next:**\n' +
      '→ Members verify in your verification channel — roles assigned automatically\n' +
      '→ Roles re-sync every 24 hours\n' +
      '→ Run `/setup` or `/config` anytime to change settings\n' +
      '→ Use `/setuptraitrole` to add more trait roles later\n' +
      '→ Planning to run giveaways or burn lotteries? Set your server\'s timezone in `/config` → 🎰 Lotteries → ⚙️ Giveaway Settings — it\'s used whenever someone schedules a giveaway with a specific date'
    )
    .setFooter({ text: 'Run /setup to update · /config to manage settings' });
}

// ── Button rows ───────────────────────────────────────────────────────────────
function welcomeRow(){
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup:start').setLabel('🚀 Get Started').setStyle(ButtonStyle.Primary)
  );
}

function collectionRow(hasContract){
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup:back:1').setLabel('← Back').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:contract').setLabel('📦 Enter Contract').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('setup:step:3').setLabel(hasContract ? 'Next →' : 'Skip →').setStyle(hasContract ? ButtonStyle.Success : ButtonStyle.Secondary),
  );
}

function channelsRow(isOcas){
  const btns = [
    new ButtonBuilder().setCustomId('setup:back:2').setLabel('← Back').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:channel:sales').setLabel('🟢 Sales').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:channel:listings').setLabel('📋 Listings').setStyle(ButtonStyle.Secondary),
  ];
  if(isOcas) btns.push(new ButtonBuilder().setCustomId('setup:channel:burn').setLabel('🔥 Burn Alerts').setStyle(ButtonStyle.Secondary));
  btns.push(new ButtonBuilder().setCustomId('setup:step:4').setLabel('Next →').setStyle(ButtonStyle.Success));
  return new ActionRowBuilder().addComponents(btns);
}

function verificationRow(configured){
  // Max 5 buttons per row — split across two rows
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup:verify:channel').setLabel('📌 Set Channel').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:verify:role').setLabel('✅ Verified Role').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:verify:holderrole').setLabel('🏆 Holder Role').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:verify:deploy').setLabel('📨 Post to Channel').setStyle(ButtonStyle.Primary).setDisabled(!configured),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup:back:3').setLabel('← Back').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:step:5').setLabel('Next →').setStyle(ButtonStyle.Success),
  );
  return [row1, row2];
}

function traitRolesRow(state, roles, guild){
  roles = roles || [];
  const rows = [];

  // Add / Next row
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup:back:4').setLabel('← Back').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:traitrole:add').setLabel('➕ Add Trait Role').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('setup:step:6').setLabel('Finish →').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('setup:skip').setLabel('Skip').setStyle(ButtonStyle.Secondary),
  ));

  // Delete select if roles exist — keyed by the trait_roles row id, so
  // deleting here actually removes the DB row (previously this only spliced
  // an in-memory wizard array, so a "deleted" role kept auto-assigning).
  if(roles.length > 0){
    const options = roles.slice(0, 25).map((r, i) => {
      const roleName = guild?.roles?.cache?.get(r.role_id)?.name || 'Unknown role';
      return new StringSelectMenuOptionBuilder()
        .setLabel(`${i+1}. ${traitRuleLabel(r)}`.slice(0, 100))
        .setDescription(`Role: ${roleName}`.slice(0, 100))
        .setValue(String(r.id));
    });
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('setup_traitrole:delete')
        .setPlaceholder('🗑️ Remove a trait role...')
        .addOptions(options)
    ));
  }

  return rows;
}

function summaryRow(){
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup:nickname:set').setLabel('🏷️ Set Nickname').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:close').setLabel('Done ✅').setStyle(ButtonStyle.Success),
  );
}

// ── Error recovery ────────────────────────────────────────────────────────────
// Any unhandled throw inside a wizard step used to leave the interaction
// unacknowledged — Discord shows "This interaction failed" and the ephemeral
// message goes dead, forcing the user back to /setup. Progress is always saved
// to server_configs before a step can throw (saveState is called after each
// mutation), so on error we surface a recovery screen instead of going silent.
function buildErrorEmbed(err){
  const msg = (err && err.message) ? err.message : 'Unknown error';
  return new EmbedBuilder()
    .setColor(0xED4245)
    .setTitle('⚠️ Something went wrong')
    .setDescription(
      SEP + '\n\n' +
      'That step hit an unexpected error, but your progress up to this point is saved.\n\n' +
      `\`${msg.slice(0, 300)}\`\n\n` +
      'Click below to pick up right where you left off, or dismiss and run `/setup` again later.'
    )
    .setFooter({ text: 'Only visible to you' });
}
function errorRow(){
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup:retry').setLabel('🔄 Continue Setup').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('setup:close').setLabel('✖️ Dismiss').setStyle(ButtonStyle.Secondary),
  );
}
async function recoverFromWizardError(interaction, ctx, err){
  console.error('[Setup] Wizard error:', err && err.message, err && err.stack);
  try{
    const payload = { content:'', embeds:[buildErrorEmbed(err)], components:[errorRow()] };
    if(interaction.deferred || interaction.replied){
      return await interaction.editReply(payload).catch(()=>{});
    }
    return await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(()=>{});
  }catch(_){
    // Nothing further we can safely do — original error is already logged above.
  }
}

// ── Handlers ──────────────────────────────────────────────────────────────────
async function handleSetupCommand(interaction, ctx){
  try{
    return await handleSetupCommandInner(interaction, ctx);
  }catch(err){
    return recoverFromWizardError(interaction, ctx, err);
  }
}
async function handleSetupCommandInner(interaction, ctx){
  await interaction.deferReply({ flags: 64 }); // ephemeral
  const { pgPool, getConfig } = ctx;
  const guildId = interaction.guildId;
  const accessCfg = (getConfig && getConfig(guildId)) || ctx.config || {};
  if(!hasSetupAccess(interaction, accessCfg)){
    return interaction.editReply({ content: SETUP_NO_ACCESS_MSG, embeds:[], components:[] });
  }
  const state = await loadState(guildId, pgPool);
  state.step = state.step || 1;

  if(state.step > 1 && state.config && Object.keys(state.config).length > 0){
    // Resume — go back to where they were
    return resumeStep(interaction, state, ctx);
  }
  state.step = 1;
  await saveState(guildId, state, pgPool);
  return interaction.editReply({ embeds:[buildWelcomeEmbed()], components:[welcomeRow()] });
}

async function resumeStep(interaction, state, ctx){
  const { pgPool } = ctx;
  const isOcas = state.config.contract?.toLowerCase() === OCAS_CONTRACT;
  const step = state.step;
  if(step <= 1) return interaction.editReply({ embeds:[buildWelcomeEmbed()], components:[welcomeRow()] });
  if(step === 2) return interaction.editReply({ embeds:[buildCollectionEmbed(state)], components:[collectionRow(!!state.config.contract)] });
  if(step === 3) return interaction.editReply({ embeds:[buildChannelsEmbed(state)], components:[channelsRow(isOcas)] });
  if(step === 4){ const v = !!(state.config.verifyChannel && state.config.verifyRole); return interaction.editReply({ embeds:[buildVerificationEmbed(state)], components:verificationRow(v) }); }
  if(step === 5){
    const roles = await fetchWizardTraitRoles(interaction.guildId, pgPool);
    return interaction.editReply({ embeds:[buildTraitRolesEmbed(state, roles)], components:traitRolesRow(state, roles, interaction.guild) });
  }
  const summaryRoles = await fetchWizardTraitRoles(interaction.guildId, pgPool);
  return interaction.editReply({ embeds:[buildSummaryEmbed(state, interaction.guild, summaryRoles)], components:[summaryRow()] });
}

async function handleSetupButton(interaction, ctx){
  try{
    return await handleSetupButtonInner(interaction, ctx);
  }catch(err){
    return recoverFromWizardError(interaction, ctx, err);
  }
}
async function handleSetupButtonInner(interaction, ctx){
  const { pgPool, setConfig, getConfig } = ctx;
  const guildId  = interaction.guildId;
  const customId = interaction.customId;

  // Access check first, before any defer/showModal.
  const accessCfg = (getConfig && getConfig(guildId)) || ctx.config || {};
  if(!hasSetupAccess(interaction, accessCfg)){
    return interaction.reply({ content: SETUP_NO_ACCESS_MSG, flags: MessageFlags.Ephemeral }).catch(()=>{});
  }

  // Defer immediately — must happen within 3s or Discord kills the interaction
  // Modals are exempt (showModal is its own response), handle those below
  // 'setup_traitrole:rolesel' used to open a modal directly and needed to skip
  // the defer — it no longer does (it now renders the category picker), so
  // it's been removed from this list. The value-picker's "Set Count" button
  // (customId ends in ':setcount') opens a modal too, so it's added here.
  const isModal = customId === 'setup:contract' || customId === 'setup:nickname:set'
    || customId.startsWith('setup:traitrole:manual:')
    || customId.startsWith('setup:traitrole:quickmodal:')
    || (customId.startsWith('vpick:wtraitrole:') && customId.endsWith(':setcount'));
  if(!isModal) await interaction.deferUpdate();

  const state = await loadState(guildId, pgPool);

  // ── retry after an error screen — just re-render the current step ─────────
  if(customId === 'setup:retry'){
    return resumeStep(interaction, state, ctx);
  }

  // ── back navigation ────────────────────────────────────────────────────────
  if(customId.startsWith('setup:back:')){
    const backTo = parseInt(customId.split(':')[2]);
    state.step = backTo;
    await saveState(guildId, state, pgPool);
    const isOcas = state.config.contract?.toLowerCase() === OCAS_CONTRACT;
    if(backTo === 1) return interaction.editReply({ content:'', embeds:[buildWelcomeEmbed()], components:[welcomeRow()] });
    if(backTo === 2) return interaction.editReply({ content:'', embeds:[buildCollectionEmbed(state)], components:[collectionRow(!!state.config.contract)] });
    if(backTo === 3) return interaction.editReply({ content:'', embeds:[buildChannelsEmbed(state)], components:[channelsRow(isOcas)] });
    if(backTo === 4){ const v=!!(state.config.verifyChannel&&state.config.verifyRole); return interaction.editReply({ content:'', embeds:[buildVerificationEmbed(state)], components:verificationRow(v) }); }
  }

  // ── step navigation ────────────────────────────────────────────────────────
  if(customId === 'setup:start' || customId.startsWith('setup:step:')){
    const step = customId === 'setup:start' ? 2 : parseInt(customId.split(':')[2]);
    state.step = step;
    const isOcas = state.config.contract?.toLowerCase() === OCAS_CONTRACT;
    await saveState(guildId, state, pgPool);

    if(step === 2) return interaction.editReply({ embeds:[buildCollectionEmbed(state)], components:[collectionRow(!!state.config.contract)] });
    if(step === 3) return interaction.editReply({ embeds:[buildChannelsEmbed(state)], components:[channelsRow(isOcas)] });
    if(step === 4){ const v = !!(state.config.verifyChannel && state.config.verifyRole); return interaction.editReply({ embeds:[buildVerificationEmbed(state)], components:verificationRow(v) }); }
    if(step === 5){
      const roles = await fetchWizardTraitRoles(guildId, pgPool);
      return interaction.editReply({ embeds:[buildTraitRolesEmbed(state, roles)], components:traitRolesRow(state, roles, interaction.guild) });
    }
    if(step === 6){
      try{
        const sc = state.config;
        // Normalize field names: wizard uses salesChannel/listingsChannel
        // poll.js uses channelId/listingsChannelId — populate both
        const merged = {
          ...sc,
          channelId:         sc.salesChannel    || sc.channelId,
          listingsChannelId: sc.listingsChannel || sc.listingsChannelId,
          slug:              sc.collectionSlug  || sc.slug,
        };
        await setConfig(guildId, merged);

        // Always sync verification_panels with latest roles — no manual re-deploy needed
        try{
          await pgPool.query(
            `INSERT INTO verification_panels (guild_id, channel_id, role_id, holder_role_id, min_tokens, welcome_text)
             VALUES ($1, $2, $3, $4, 0, $5)
             ON CONFLICT (guild_id) DO UPDATE SET
               channel_id    = COALESCE($2, verification_panels.channel_id),
               role_id       = COALESCE($3, verification_panels.role_id),
               holder_role_id= COALESCE($4, verification_panels.holder_role_id)`,
            [guildId, sc.verifyChannel||null, sc.verifyRole||null, sc.holderRole||null,
             'Link your wallet to prove ownership and unlock holder roles.']
          );
        }catch(e){ console.warn('[Setup] panel sync:', e.message); }
      }catch(e){ console.error('[Setup] Save error:', e.message); }
      await clearWizardState(guildId, pgPool);
      const finishRoles = await fetchWizardTraitRoles(guildId, pgPool);
      return interaction.editReply({ embeds:[buildSummaryEmbed(state, interaction.guild, finishRoles)], components:[summaryRow()] });
    }
  }

  // ── contract modal ─────────────────────────────────────────────────────────
  if(customId === 'setup:contract'){
    const modal = new ModalBuilder().setCustomId('setup_modal:contract').setTitle('Collection Details');
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('contract_input').setLabel('NFT Contract Address (0x...)')
          .setStyle(TextInputStyle.Short).setPlaceholder('0xdce7bfe9ad997c1676cae8c5b5468272e878e5ad')
          .setRequired(true).setMinLength(42).setMaxLength(42)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('slug_input').setLabel('OpenSea Collection Slug')
          .setStyle(TextInputStyle.Short).setPlaceholder('your-collection-slug')
          .setRequired(false).setMaxLength(100)
      ),
    );
    return interaction.showModal(modal);
  }

  // ── channel selectors ──────────────────────────────────────────────────────
  if(customId.startsWith('setup:channel:')){
    const type  = customId.split(':')[2];
    const label = type === 'sales' ? '🟢 Sales' : type === 'listings' ? '📋 Listings' : '🔥 Burn Alerts';
    const menu  = new ChannelSelectMenuBuilder()
      .setCustomId('setup_chsel:'+type).setPlaceholder('Pick the '+label+' channel')
      .addChannelTypes(ChannelType.GuildText);
    return interaction.editReply({ content:'**Select the '+label+' channel:**', components:[new ActionRowBuilder().addComponents(menu)], embeds:[] });
  }

  // ── verification pickers ───────────────────────────────────────────────────
  if(customId === 'setup:verify:channel'){
    const menu = new ChannelSelectMenuBuilder()
      .setCustomId('setup_chsel:verify').setPlaceholder('Pick the verification channel')
      .addChannelTypes(ChannelType.GuildText);
    return interaction.editReply({ content:'**Select the verification channel:**', components:[new ActionRowBuilder().addComponents(menu)], embeds:[] });
  }

  if(customId === 'setup:verify:role'){
    const { rows, pageLabel } = buildRolePickerRows(interaction.guild, 'setup_rolesel:verify', null, 'Pick the ✅ Verified Wallet role');
    return interaction.editReply({ content:'**Select the ✅ Verified Wallet role** (given to anyone who links a wallet):'+pageLabel, components: rows, embeds:[] });
  }

  if(customId === 'setup:verify:holderrole'){
    const { rows, pageLabel } = buildRolePickerRows(interaction.guild, 'setup_rolesel:holder', null, 'Pick the 🏆 Holder role');
    return interaction.editReply({ content:'**Select the 🏆 Holder role** (given to members who hold ≥1 token):'+pageLabel, components: rows, embeds:[] });
  }

  if(customId === 'setup:verify:deploy'){
    try{
      const ch = await interaction.guild.channels.fetch(state.config.verifyChannel).catch(()=>null);
      if(!ch) return interaction.editReply({ content:'❌ Could not find verification channel.' });

      const guildName = interaction.guild.name;
      const panelEmbed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(`🔐 ${guildName} — Verify Ownership`)
        .setDescription(
          'Link your wallet to prove ownership and unlock holder roles.\n\n' +
          '**How it works:**\n' +
          '→ Click the button below\n' +
          '→ Enter your wallet address\n' +
          '→ Add a short code to your OpenSea username\n' +
          '→ Roles are assigned automatically\n\n' +
          '*This bot will never DM you or ask for your seed phrase.*'
        )
        .setThumbnail(interaction.guild.iconURL({ dynamic: true }) || null);

      const startBtn = new ButtonBuilder()
        .setCustomId('start_verification:'+guildId).setLabel('Verify Wallet').setStyle(ButtonStyle.Primary).setEmoji('🔗');

      const msg = await ch.send({ embeds:[panelEmbed], components:[new ActionRowBuilder().addComponents(startBtn)] });
      state.config.verifyMessageId = msg.id;
      await saveState(guildId, state, pgPool);

      await pgPool.query(
        `INSERT INTO verification_panels (guild_id,channel_id,role_id,holder_role_id,min_tokens,message_id,welcome_text)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (guild_id) DO UPDATE SET channel_id=$2,role_id=$3,holder_role_id=$4,min_tokens=$5,message_id=$6,welcome_text=$7`,
        [guildId, state.config.verifyChannel, state.config.verifyRole||null, state.config.holderRole||null, 0, msg.id, `Link your wallet to prove ownership and unlock holder roles in ${guildName}.`]
      );

      const v = !!(state.config.verifyChannel && state.config.verifyRole);
      return interaction.editReply({ content:'✅ Panel deployed!', embeds:[buildVerificationEmbed(state)], components:verificationRow(v) });
    }catch(e){
      console.error('[Setup] Deploy panel error:', e.message);
      return interaction.editReply({ content:'❌ Failed to deploy panel: '+e.message });
    }
  }

  // ── channel / role select menus ────────────────────────────────────────────
  if(customId.startsWith('setup_chsel:') || customId.startsWith('setup_rolesel:')){
    const type  = customId.split(':')[1];
    const isOcas = state.config.contract?.toLowerCase() === OCAS_CONTRACT;

    if(customId.startsWith('setup_chsel:')){
      const chId = interaction.values[0];
      if(type === 'sales')    state.config.salesChannel    = chId;
      if(type === 'listings') state.config.listingsChannel = chId;
      if(type === 'burn')     state.config.burnChannel     = chId;
      if(type === 'verify')   state.config.verifyChannel   = chId;
      await saveState(guildId, state, pgPool);
      if(type === 'verify'){
        const v = !!(state.config.verifyChannel && state.config.verifyRole);
        return interaction.editReply({ content:'', embeds:[buildVerificationEmbed(state)], components:verificationRow(v) });
      }
      return interaction.editReply({ content:'', embeds:[buildChannelsEmbed(state)], components:[channelsRow(isOcas)] });
    }

    if(customId.startsWith('setup_rolesel:')){
      const roleId = interaction.values[0];
      if(type === 'verify') state.config.verifyRole = roleId;
      if(type === 'holder') state.config.holderRole = roleId;
      await saveState(guildId, state, pgPool);
      const v = !!(state.config.verifyChannel && state.config.verifyRole);
      return interaction.editReply({ content:'', embeds:[buildVerificationEmbed(state)], components:verificationRow(v) });
    }
  }

  // ── trait role: add ────────────────────────────────────────────────────────
  if(customId === 'setup:traitrole:add'){
    const { rows, pageLabel } = buildRolePickerRows(interaction.guild, 'setup_traitrole:rolesel', 'setup:step:5', 'Pick a role to assign...');
    return interaction.editReply({
      content: '**Step 1 of 3 — Pick the Discord role to assign:**'+pageLabel,
      embeds: [],
      components: rows,
    });
  }

  // ── trait role: role selected → guided category picker (dropdowns) ────────
  // Previously this opened a free-text modal (type/value/count typed by hand).
  // Now it mirrors /config's guided flow: category dropdown → value dropdown
  // (paginated "menu X of Y" past 25 options) → optional count, all sourced
  // from the collection's own cached traits so nothing has to be typed.
  if(customId.startsWith('setup_traitrole:rolesel')){
    const roleId = interaction.values[0];
    const role   = await interaction.guild.roles.fetch(roleId).catch(()=>null);
    const slug   = state.config.collectionSlug || state.config.slug || '';
    const isOcas = state.config.contract?.toLowerCase() === OCAS_CONTRACT;

    const catRes = await pgPool.query(
      `SELECT DISTINCT trait_name FROM collection_traits WHERE slug=$1 ORDER BY trait_name`,
      [slug]
    ).catch(()=>({ rows:[] }));
    const categories = catRes.rows.map(r => r.trait_name).filter(Boolean);

    if(!categories.length){
      return interaction.editReply({
        content: `**Adding trait role for ${role?.name || 'role'}**\n\nNo cached trait data found for this collection yet. Click below to enter the trait manually.`,
        embeds: [],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`setup:traitrole:manual:${roleId}`).setLabel('✏️ Enter Manually').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('setup:step:5').setLabel('← Cancel').setStyle(ButtonStyle.Secondary),
          ),
        ],
      });
    }

    // Special options (Token Count + burn-based, when OCAS) go first, menu 0 only.
    const specialCount = isOcas ? 3 : 1;
    const CAT_CHUNK = 25;
    const catMenuCount = Math.min(4, Math.ceil((categories.length + specialCount) / CAT_CHUNK));
    const catRows = [];
    for(let i = 0; i < catMenuCount; i++){
      const startIdx = i === 0 ? 0 : i * CAT_CHUNK - specialCount;
      const roomLeft = i === 0 ? CAT_CHUNK - specialCount : CAT_CHUNK;
      const slice = categories.slice(startIdx, startIdx + roomLeft);
      if(!slice.length && i > 0) break;
      const opts = slice.map(c => new StringSelectMenuOptionBuilder().setLabel(c.slice(0,100)).setValue(c));
      if(i === 0){
        opts.unshift(new StringSelectMenuOptionBuilder()
          .setLabel('🪙 Token Count').setValue('_count')
          .setDescription('Assign role based on how many tokens the user holds'));
        if(isOcas){
          opts.unshift(new StringSelectMenuOptionBuilder()
            .setLabel('🔥 Total Burns').setValue('_totalburns')
            .setDescription('Number of separate burn transactions this wallet has ever done'));
          opts.unshift(new StringSelectMenuOptionBuilder()
            .setLabel('💥 Biggest Single Burn').setValue('_maxburn')
            .setDescription('Largest number of tokens fed into any ONE burn transaction'));
        }
      }
      const m = new StringSelectMenuBuilder()
        .setCustomId(`setup_traitrole:catsel:${roleId}:${i}`)
        .setPlaceholder(catMenuCount > 1 ? `Categories (menu ${i+1} of ${catMenuCount})` : 'Step 2 of 3 — Pick a trait category...')
        .addOptions(opts.slice(0, 25));
      catRows.push(new ActionRowBuilder().addComponents(m));
    }
    catRows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('setup:step:5').setLabel('← Cancel').setStyle(ButtonStyle.Secondary)
    ));
    return interaction.editReply({
      content: `**Adding trait role for ${role?.name || 'role'}**\n\nStep 2 of 3 — Pick the trait category:`,
      embeds: [],
      components: catRows,
    });
  }

  // ── trait role: category selected → value picker (or count shortcut) ──────
  if(customId.startsWith('setup_traitrole:catsel:')){
    const parts    = customId.split(':');
    const roleId   = parts[2];
    const category = interaction.values[0];

    if(category === '_count' || category === '_totalburns' || category === '_maxburn'){
      const labels = {
        _count:      ['Token Count Rule', 'Set Token Count', 'the minimum token count'],
        _totalburns: ['Total Burns Rule', 'Set Total Burns', 'the minimum number of burn transactions this wallet has ever done'],
        _maxburn:    ['Biggest Single Burn Rule', 'Set Burn Size', 'the minimum tokens in any ONE burn transaction'],
      }[category];
      return interaction.editReply({
        content: `**${labels[0]}**\n\nClick below to set ${labels[2]} for this role.`,
        embeds: [],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`setup:traitrole:quickmodal:${roleId}:${category}`).setLabel(`✏️ ${labels[1]}`).setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('setup:step:5').setLabel('← Cancel').setStyle(ButtonStyle.Secondary),
          ),
        ],
      });
    }

    const slug = state.config.collectionSlug || state.config.slug || '';
    const valRes = await pgPool.query(
      `SELECT DISTINCT trait_value FROM collection_traits WHERE slug=$1 AND trait_name=$2 ORDER BY trait_value`,
      [slug, category]
    ).catch(()=>({ rows:[] }));
    const values = valRes.rows.map(r => r.trait_value).filter(Boolean);
    if(!values.length){
      return interaction.editReply({ content: `❌ No trait values found for category **${category}**. Try again.`, embeds:[], components:[] });
    }

    const sessionKey = `${interaction.user.id}:wtraitrole:${roleId}:${category}`;
    initValuePicker(sessionKey, values);
    const customIdPrefix = `wtraitrole:${roleId}:${encodeURIComponent(category)}`;
    const { rows, truncatedNote } = buildStackedValuePickerRows(sessionKey, customIdPrefix, {
      placeholder: 'Pick one or more values...',
      cancelId: 'setup:step:5',
      countButton: true,
    });
    return interaction.editReply({
      content: `**Adding trait role**\n\nCategory: **${category}**\nStep 3 of 3 — Pick the trait value(s) that qualify${truncatedNote}\n\nPick from as many of the menus below as you want, then Done to finish (defaults to needing 1), or Set Count first for a different minimum.`,
      embeds: [],
      components: rows,
    });
  }

  // ── trait role: paginated value picker dispatch (sel / setcount / done) ───
  if(customId.startsWith('vpick:wtraitrole:')){
    try{
      const parsed = parseValuePickerCustomId(customId);
      if(!parsed){
        return interaction.editReply({ content: '❌ Something went wrong with this picker. Please start over.', embeds:[], components:[] });
      }
      const { action, customIdPrefix } = parsed;
      const [, roleId, catEnc] = customIdPrefix.split(':');
      const category = decodeURIComponent(catEnc);
      const sessionKey = `${interaction.user.id}:wtraitrole:${roleId}:${category}`;
      const session = getValuePickerSession(sessionKey);
      if(!session){
        return interaction.editReply({ content: '❌ This picker session expired (likely a bot restart mid-flow). Please start over.', embeds:[], components:[] });
      }

      if(action === 'sel'){
        recordMenuSelection(sessionKey, parsed.menuIndex, interaction.values || []);
        const { rows, truncatedNote } = buildStackedValuePickerRows(sessionKey, customIdPrefix, {
          placeholder: 'Pick one or more values...', cancelId: 'setup:step:5', countButton: true,
        });
        return interaction.editReply({
          content: `**${category}**${truncatedNote}\n\npick from as many of the menus below as you want, then Done to finish (defaults to needing 1), or Set Count first for a different minimum.`,
          embeds: [], components: rows,
        });
      }

      if(action === 'setcount'){
        if(!session.selected.size){
          return interaction.editReply({ content: 'No values were selected. Please pick at least one value first.', embeds:[], components:[] });
        }
        const modal = new ModalBuilder()
          .setCustomId(`setup_modal:trcount:${roleId}:${encodeURIComponent(category)}`)
          .setTitle(`${category}`.slice(0, 45));
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('tr_count_min')
            .setLabel('How many needed? (default: 1)')
            .setStyle(TextInputStyle.Short).setPlaceholder('e.g. 1, 3, 5').setRequired(false)
        ));
        return interaction.showModal(modal);
      }

      if(action === 'done'){
        const selectedValues = [...session.selected];
        clearValuePicker(sessionKey);
        if(!selectedValues.length){
          return interaction.editReply({ content: 'No values were selected — nothing added.', embeds:[], components:[] });
        }
        for(const val of selectedValues){
          await pgPool.query(
            `INSERT INTO trait_roles (guild_id, role_id, trait_type, trait_value, minimum_count, collection_slug)
             VALUES ($1,$2,$3,$4,1,NULL)
             ON CONFLICT (guild_id, trait_type, COALESCE(trait_value,''), role_id, minimum_count) DO UPDATE SET collection_slug=NULL`,
            [guildId, roleId, category, val]
          ).catch(e => console.warn('[Setup] trait_roles insert:', e.message));
        }
        const roles = await fetchWizardTraitRoles(guildId, pgPool);
        return interaction.editReply({
          content: `✅ Added **${selectedValues.length}** trait role rule${selectedValues.length > 1 ? 's' : ''} for <@&${roleId}>:\n${selectedValues.map(v=>`• ${category}: ${v}`).join('\n')}`,
          embeds: [buildTraitRolesEmbed(state, roles)],
          components: traitRolesRow(state, roles, interaction.guild),
        });
      }
    }catch(e){
      console.error('[Setup] vpick dispatcher error:', e);
      return interaction.editReply({ content: `❌ Something went wrong saving your picks: ${e.message || 'unknown error'}. Please try again or start over.`, embeds:[], components:[] }).catch(()=>{});
    }
  }

  // ── trait role: manual fallback entry (no cached trait data) ──────────────
  if(customId.startsWith('setup:traitrole:manual:')){
    const roleId = customId.split(':')[3];
    const role = await interaction.guild.roles.fetch(roleId).catch(()=>null);
    const modal = new ModalBuilder()
      .setCustomId('setup_modal:traitrole:'+roleId)
      .setTitle(`Role: ${(role?.name || 'Selected').slice(0, 40)}`);
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('tr_trait_type')
          .setLabel('Trait Category (optional — e.g. Type)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Leave blank to require a token count instead')
          .setRequired(false)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('tr_trait_value')
          .setLabel('Trait Value (optional — e.g. Zombie, Gold)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Leave blank if using token count')
          .setRequired(false)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('tr_min_count')
          .setLabel('Minimum tokens to qualify (default: 1)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. 1, 5, 20')
          .setRequired(false)
      ),
    );
    return interaction.showModal(modal);
  }

  // ── trait role: quick-modal for _count/_totalburns/_maxburn (number only) ─
  if(customId.startsWith('setup:traitrole:quickmodal:')){
    const parts    = customId.split(':');
    const roleId   = parts[3];
    const category = parts[4];
    const role = await interaction.guild.roles.fetch(roleId).catch(()=>null);
    const fieldLabels = {
      _count:      'Minimum tokens owned (default: 1)',
      _totalburns: 'Minimum burn transactions (default: 1)',
      _maxburn:    'Minimum tokens in one burn (default: 1)',
    };
    const modal = new ModalBuilder()
      .setCustomId(`setup_modal:trquick:${roleId}:${category}`)
      .setTitle(`Role: ${(role?.name || 'Selected').slice(0, 40)}`);
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('tr_quick_count')
        .setLabel((fieldLabels[category] || 'Minimum count').slice(0, 45))
        .setStyle(TextInputStyle.Short).setPlaceholder('e.g. 1, 5, 10').setRequired(false)
    ));
    return interaction.showModal(modal);
  }

  // ── trait role: delete select — removes the actual trait_roles DB row ─────
  // (previously this only spliced an in-memory wizard array; the DB row
  // stayed active and kept auto-assigning even after "deleting" it here)
  if(customId === 'setup_traitrole:delete'){
    const rowId = parseInt(interaction.values[0]);
    if(!isNaN(rowId)){
      await pgPool.query('DELETE FROM trait_roles WHERE id=$1 AND guild_id=$2', [rowId, guildId]).catch(e=>console.warn('[Setup] trait_roles delete:', e.message));
    }
    const roles = await fetchWizardTraitRoles(guildId, pgPool);
    return interaction.editReply({ content:'', embeds:[buildTraitRolesEmbed(state, roles)], components:traitRolesRow(state, roles, interaction.guild) });
  }

  // ── optional: set nickname from the finish screen ───────────────────────────
  if(customId === 'setup:nickname:set'){
    const currentNickname = interaction.guild.members.me?.nickname || '';
    const modal = new ModalBuilder().setCustomId('cfg_modal:nickname').setTitle('Set Bot Nickname');
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('nickname_input')
        .setLabel('Nickname (max 32 characters)')
        .setStyle(TextInputStyle.Short)
        .setValue(currentNickname)
        .setMaxLength(32)
        .setRequired(true)
    ));
    return interaction.showModal(modal);
  }

  // ── close / skip ───────────────────────────────────────────────────────────
  if(customId === 'setup:close' || customId === 'setup:skip'){
    if(customId === 'setup:close'){
      await clearWizardState(guildId, pgPool);
      return interaction.editReply({ embeds:[], components:[], content:'✅ Setup complete!\n\n→ Run `/setup` anytime to update settings.\n→ Use `/config` to manage channels, roles and collections.' });
    }
    // skip just advances to next step
    const nextStep = (state.step || 5) + 1;
    state.step = nextStep;
    await saveState(guildId, state, pgPool);
    const isOcas = state.config.contract?.toLowerCase() === OCAS_CONTRACT;
    if(nextStep === 6){
      try{
        const sc = state.config;
        const merged = { ...sc, channelId: sc.salesChannel||sc.channelId, listingsChannelId: sc.listingsChannel||sc.listingsChannelId, slug: sc.collectionSlug||sc.slug };
        await setConfig(guildId, merged);

        // Always sync verification_panels with latest roles — no manual re-deploy needed
        try{
          await pgPool.query(
            `INSERT INTO verification_panels (guild_id, channel_id, role_id, holder_role_id, min_tokens, welcome_text)
             VALUES ($1, $2, $3, $4, 0, $5)
             ON CONFLICT (guild_id) DO UPDATE SET
               channel_id    = COALESCE($2, verification_panels.channel_id),
               role_id       = COALESCE($3, verification_panels.role_id),
               holder_role_id= COALESCE($4, verification_panels.holder_role_id)`,
            [guildId, sc.verifyChannel||null, sc.verifyRole||null, sc.holderRole||null,
             'Link your wallet to prove ownership and unlock holder roles.']
          );
        }catch(e){ console.warn('[Setup] panel sync:', e.message); }
      }catch(_){}
      await clearWizardState(guildId, pgPool);
      return interaction.editReply({ embeds:[buildSummaryEmbed(state, interaction.guild)], components:[summaryRow()] });
    }
    return interaction.editReply({ embeds:[buildTraitRolesEmbed(state)], components:traitRolesRow(state) });
  }
}

async function handleSetupModal(interaction, ctx){
  try{
    return await handleSetupModalInner(interaction, ctx);
  }catch(err){
    return recoverFromWizardError(interaction, ctx, err);
  }
}
async function handleSetupModalInner(interaction, ctx){
  const { pgPool, setConfig, getConfig } = ctx;
  const guildId  = interaction.guildId;
  const customId = interaction.customId;

  const accessCfg = (getConfig && getConfig(guildId)) || ctx.config || {};
  if(!hasSetupAccess(interaction, accessCfg)){
    return interaction.reply({ content: SETUP_NO_ACCESS_MSG, flags: MessageFlags.Ephemeral }).catch(()=>{});
  }

  await interaction.deferUpdate();
  const state = await loadState(guildId, pgPool);

  // ── contract address ───────────────────────────────────────────────────────
  if(customId === 'setup_modal:contract'){
    const contract = interaction.fields.getTextInputValue('contract_input').trim().toLowerCase();
    if(!/^0x[0-9a-f]{40}$/i.test(contract))
      return interaction.editReply({ content:'❌ Invalid contract address. Must be 0x followed by 40 hex characters.' });
    const slugRaw = interaction.fields.getTextInputValue('slug_input').trim().toLowerCase().replace(/\s+/g, '-');
    state.config.contract = contract;
    const isOcas = contract === OCAS_CONTRACT;
    if(isOcas){
      state.config.contractName   = 'On-Chain All Stars';
      state.config.collectionSlug = OCAS_SLUG;
      state.config.isOcas         = true;
      fetchAndStoreCollectionTraits(OCAS_SLUG, pgPool).catch(()=>{});
    } else if(slugRaw){
      state.config.collectionSlug = slugRaw;
      state.config.slug           = slugRaw;
      // Fire-and-forget: cache OS trait counts + kick off token trait backfill
      fetchAndStoreCollectionTraits(slugRaw, pgPool).catch(()=>{});
      try{
        const { maybeStartBackfill } = require('../lib/auto-backfill');
        maybeStartBackfill(pgPool, { contract, slug: slugRaw }).catch(()=>{});
      }catch(_){}
    }
    await saveState(guildId, state, pgPool);
    return interaction.editReply({ content:'', embeds:[buildCollectionEmbed(state)], components:[collectionRow(true)] });
  }

  // ── add trait role (manual fallback — only reached when no cached trait
  //    data exists for the collection yet, see setup_traitrole:rolesel) ──────
  if(customId.startsWith('setup_modal:traitrole:')){
    const roleId      = customId.split(':')[2];
    const traitTypeRaw = interaction.fields.getTextInputValue('tr_trait_type').trim();
    const traitVal     = interaction.fields.getTextInputValue('tr_trait_value').trim();
    const minCount     = parseInt(interaction.fields.getTextInputValue('tr_min_count').trim()) || 1;
    // If no trait category entered, treat as a token count rule
    const traitType    = traitTypeRaw || '_count';

    const role = await interaction.guild.roles.fetch(roleId).catch(()=>null);
    if(!role)
      return interaction.editReply({ content:'❌ Role not found. Please try again.' });

    try{
      await pgPool.query(
        `INSERT INTO trait_roles (guild_id, role_id, trait_type, trait_value, minimum_count, collection_slug)
         VALUES ($1,$2,$3,$4,$5,NULL)
         ON CONFLICT (guild_id, trait_type, COALESCE(trait_value,''), role_id, minimum_count) DO UPDATE SET collection_slug=NULL`,
        [guildId, roleId, traitType, traitVal||'', minCount]
      );
    }catch(e){ console.warn('[Setup] trait_roles insert:', e.message); }

    const roles = await fetchWizardTraitRoles(guildId, pgPool);
    return interaction.editReply({ content:'', embeds:[buildTraitRolesEmbed(state, roles)], components:traitRolesRow(state, roles, interaction.guild) });
  }

  // ── trait role: quick-modal submit (numeric-only categories) ──────────────
  if(customId.startsWith('setup_modal:trquick:')){
    const parts    = customId.split(':');
    const roleId   = parts[2];
    const category = parts[3];
    const minCount = parseInt(interaction.fields.getTextInputValue('tr_quick_count').trim()) || 1;

    const role = await interaction.guild.roles.fetch(roleId).catch(()=>null);
    if(!role) return interaction.editReply({ content:'❌ Role not found. Please try again.' });

    await pgPool.query(
      `INSERT INTO trait_roles (guild_id, role_id, trait_type, trait_value, minimum_count, collection_slug)
       VALUES ($1,$2,$3,'',$4,NULL)
       ON CONFLICT (guild_id, trait_type, COALESCE(trait_value,''), role_id, minimum_count) DO UPDATE SET collection_slug=NULL`,
      [guildId, roleId, category, minCount]
    ).catch(e => console.warn('[Setup] trait_roles insert:', e.message));

    const roles = await fetchWizardTraitRoles(guildId, pgPool);
    return interaction.editReply({ content:'✅ Trait role added.', embeds:[buildTraitRolesEmbed(state, roles)], components:traitRolesRow(state, roles, interaction.guild) });
  }

  // ── trait role: custom-count modal submit — finalizes a value-picker session ──
  if(customId.startsWith('setup_modal:trcount:')){
    const parts    = customId.split(':');
    const roleId   = parts[2];
    const category = decodeURIComponent(parts[3]);
    const minCount = parseInt(interaction.fields.getTextInputValue('tr_count_min').trim()) || 1;

    const sessionKey = `${interaction.user.id}:wtraitrole:${roleId}:${category}`;
    const session = getValuePickerSession(sessionKey);
    if(!session || !session.selected.size){
      return interaction.editReply({ content: '❌ This session expired before you set a count. Please pick the value(s) again.', embeds:[], components:[] });
    }
    const selectedValues = [...session.selected];
    clearValuePicker(sessionKey);

    for(const val of selectedValues){
      await pgPool.query(
        `INSERT INTO trait_roles (guild_id, role_id, trait_type, trait_value, minimum_count, collection_slug)
         VALUES ($1,$2,$3,$4,$5,NULL)
         ON CONFLICT (guild_id, trait_type, COALESCE(trait_value,''), role_id, minimum_count) DO UPDATE SET collection_slug=NULL`,
        [guildId, roleId, category, val, minCount]
      ).catch(e => console.warn('[Setup] trait_roles insert:', e.message));
    }

    const roles = await fetchWizardTraitRoles(guildId, pgPool);
    return interaction.editReply({
      content: `✅ Added **${selectedValues.length}** trait role rule${selectedValues.length > 1 ? 's' : ''} for <@&${roleId}> (need ${minCount}+):\n${selectedValues.map(v=>`• ${category}: ${v}`).join('\n')}`,
      embeds: [buildTraitRolesEmbed(state, roles)],
      components: traitRolesRow(state, roles, interaction.guild),
    });
  }

  // channel/role selects handled in handleSetupButton
}

const SETUP_COMMANDS = new Set(['setup']);
module.exports = { handleSetupCommand, handleSetupButton, handleSetupModal, SETUP_COMMANDS };
















