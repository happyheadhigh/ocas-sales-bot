'use strict';

const {
  IMAGE_CACHE_TTL, IMAGE_CACHE_MAX, IMAGE_CACHE_EVICT, OCAS_TRAITS_CACHE_MAX,
} = require('./constants');

// ── Image cache ───────────────────────────────────────────────────────────────
const imageCache = new Map();

function getCachedImage(key){
  const entry = imageCache.get(key);
  if(!entry) return null;
  if(Date.now() - entry.ts > IMAGE_CACHE_TTL){ imageCache.delete(key); return null; }
  return entry.result;
}

function setCachedImage(key, result){
  if(imageCache.size >= IMAGE_CACHE_MAX){
    // Map preserves insertion order — first keys are oldest, no sort needed
    let evicted = 0;
    for(const k of imageCache.keys()){
      imageCache.delete(k);
      if(++evicted >= IMAGE_CACHE_EVICT) break;
    }
  }
  imageCache.set(key, { result, ts: Date.now() });
}

// ── Token traits cache ────────────────────────────────────────────────────────
const ocasTraitsCache = new Map(); // tokenId → {traits, expires}

function getCachedTraits(tokenId){
  const entry = ocasTraitsCache.get(tokenId);
  if(!entry) return null;
  if(Date.now() > entry.expires){ ocasTraitsCache.delete(tokenId); return null; }
  return entry.traits;
}

function setCachedTraits(tokenId, traits){
  if(ocasTraitsCache.size >= OCAS_TRAITS_CACHE_MAX){
    const oldest = [...ocasTraitsCache.keys()].slice(0, 200);
    for(const k of oldest) ocasTraitsCache.delete(k);
  }
  ocasTraitsCache.set(tokenId, { traits, expires: Date.now() + 5 * 60 * 1000 });
}

// ── Session stores ────────────────────────────────────────────────────────────
const sweepSessions     = new Map(); // sessionId → { listings, page }
const slideshowSessions = new Map(); // messageId → { tokens, page, ... }

// ── Dedup / cooldown sets ─────────────────────────────────────────────────────
const recentChannelPosts = new Map(); // channelId → Set of token+type keys
const alertedEventIds    = new Set(); // dedup for personal DM alerts
const userCooldowns      = new Map(); // userId → last command ts

function checkCooldown(userId, ms = 8000){
  const last = userCooldowns.get(userId) || 0;
  if(Date.now() - last < ms) return false;
  userCooldowns.set(userId, Date.now());
  return true;
}

function dedupeChannelPost(channelId, key){
  if(!recentChannelPosts.has(channelId)) recentChannelPosts.set(channelId, new Set());
  const set = recentChannelPosts.get(channelId);
  if(set.has(key)) return false;
  set.add(key);
  if(set.size > 500) set.delete(set.values().next().value);
  return true;
}

module.exports = {
  imageCache, getCachedImage, setCachedImage,
  ocasTraitsCache, getCachedTraits, setCachedTraits,
  sweepSessions, slideshowSessions,
  recentChannelPosts, alertedEventIds, userCooldowns,
  checkCooldown, dedupeChannelPost,
};
