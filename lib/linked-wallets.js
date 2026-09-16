'use strict';

// Multiple-wallets-per-user support (jv: "I have 2 separate wallets that I
// want connected. The bot should support multiple wallets."). Reads/writes
// linked_wallets (lib/db.js) — additive by design, wallet is part of the
// primary key rather than being replaced by it, unlike user_registrations
// which stays one-wallet-per-(discord_id,guild_id) and is still maintained
// in parallel as a fallback during the transition.

// Returns every wallet linked for this user in this guild, lowercased.
// verifiedOnly (default true) matches how every existing role/holdings
// check already only trusted verified wallets.
async function getLinkedWallets(pgPool, discordId, guildId, verifiedOnly = true){
  try{
    const r = await pgPool.query(
      verifiedOnly
        ? `SELECT wallet, verified, verified_at, linked_at FROM linked_wallets WHERE discord_id=$1 AND guild_id=$2 AND verified=true ORDER BY linked_at ASC`
        : `SELECT wallet, verified, verified_at, linked_at FROM linked_wallets WHERE discord_id=$1 AND guild_id=$2 ORDER BY linked_at ASC`,
      [discordId, guildId]
    );
    return r.rows;
  }catch(e){
    console.error('[linked-wallets] getLinkedWallets error:', e.message);
    return [];
  }
}

// Convenience for callers that just need the address strings (the common
// case — role sync, holdings aggregation).
async function getLinkedWalletAddresses(pgPool, discordId, guildId, verifiedOnly = true){
  const rows = await getLinkedWallets(pgPool, discordId, guildId, verifiedOnly);
  return rows.map(r => r.wallet);
}

// Adds (or re-verifies) one wallet for this user. Does NOT touch any other
// wallet already linked for them — this is the actual fix for the
// overwrite bug in user_registrations' own upsert pattern.
async function addLinkedWallet(pgPool, discordId, guildId, wallet, verified = true){
  const w = String(wallet || '').trim().toLowerCase();
  if(!/^0x[0-9a-f]{40}$/.test(w)) throw new Error('Invalid wallet address');
  await pgPool.query(
    `INSERT INTO linked_wallets (discord_id, guild_id, wallet, verified, verified_at, linked_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $4 THEN NOW() ELSE NULL END, NOW())
     ON CONFLICT (discord_id, guild_id, wallet)
     DO UPDATE SET verified = $4, verified_at = CASE WHEN $4 THEN NOW() ELSE linked_wallets.verified_at END`,
    [discordId, guildId, w, verified]
  );
  return w;
}

async function removeLinkedWallet(pgPool, discordId, guildId, wallet){
  const w = String(wallet || '').trim().toLowerCase();
  await pgPool.query(
    `DELETE FROM linked_wallets WHERE discord_id=$1 AND guild_id=$2 AND wallet=$3`,
    [discordId, guildId, w]
  );
}

// Reverse lookup — same shape as bot.js's existing lookupDiscordPing(), but
// checks every linked wallet rather than only the one in user_registrations
// (a giveaway winner's wallet might be their second linked wallet, not
// necessarily the one that table happens to have).
async function findDiscordIdByWallet(pgPool, wallet){
  const w = String(wallet || '').trim().toLowerCase();
  if(!w) return null;
  try{
    const r = await pgPool.query(
      `SELECT discord_id FROM linked_wallets WHERE wallet=$1 AND verified=true LIMIT 1`,
      [w]
    );
    return r.rows[0]?.discord_id || null;
  }catch(_){ return null; }
}

module.exports = {
  getLinkedWallets,
  getLinkedWalletAddresses,
  addLinkedWallet,
  removeLinkedWallet,
  findDiscordIdByWallet,
};
