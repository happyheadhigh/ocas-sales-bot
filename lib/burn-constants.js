'use strict';

// ── Burn machine constants ────────────────────────────────────────────────────
const BURN_ALERT_CHANNEL_ID          = process.env.BURN_ALERT_CHANNEL_ID || '';
const BURN_BACKFILL_ALERTS           = String(process.env.BURN_BACKFILL_ALERTS || 'false').toLowerCase() === 'true';
const BURN_METADATA_REFRESH_ENABLED  = true;

const BURN_COLORS = {
  FIRE:        0xFF6B00,
  RADIOACTIVE: 0x39FF14,
  ZOMBIE:      0x7CFC00,
  SKELETON:    0xC0C0C0,
  HUMAN:       0xFF6B00,
  ANGEL:       0xFFD700,
};

// E_1_Type: 0-5=Human variants, 6=Zombie, 7=Ape, 8=Skeleton, 9=Alien, 10=Radioactive, 11=Demonic
const E1_TYPE_NAMES = {
  0: 'Human', 1: 'Human', 2: 'Human', 3: 'Human', 4: 'Human', 5: 'Human',
  6: 'Zombie', 7: 'Ape', 8: 'Skeleton', 9: 'Alien', 10: 'Radioactive', 11: 'Demonic',
};

function burnTypeLabel(bodyType, isAngel){
  const base = E1_TYPE_NAMES[bodyType] || ('Type ' + bodyType);
  return isAngel ? base + ' Angel' : base;
}

function burnTypeColor(bodyType, isAngel){
  if(isAngel) return BURN_COLORS.ANGEL;
  switch(Number(bodyType)){
    case 10: return BURN_COLORS.RADIOACTIVE;
    case 8:  return BURN_COLORS.SKELETON;
    case 6:  return BURN_COLORS.ZOMBIE;
    default: return BURN_COLORS.HUMAN;
  }
}

function burnTypeEmoji(bodyType, isAngel){
  if(isAngel) return '😇';
  switch(Number(bodyType)){
    case 10: return '☢️';
    case 8:  return '💀';
    case 6:  return '🧟';
    default: return '🔥';
  }
}

function normalizeOcasType(bodyType, isAngel){
  if(isAngel) return 'Angel';
  const t = Number(bodyType);
  if(t >= 0 && t <= 5) return 'Human';
  return E1_TYPE_NAMES[t] || ('Type ' + t);
}

// Event topic signatures (keccak256)
const TOPIC_BURN_STARTED   = '0x4dd367d2c410889fbff76f34abdefdceb947ad0c58baaf327ead8ac9d6a38c22';
const TOPIC_BURN_FINALIZED = '0x4c7b2090df533e8b1f7bd4ab01aadb95fedf5006f15ff4300c1709b97c4c6d5e';

const BURN_STARTED_ABI = [
  'event BurnStarted(address indexed owner, uint256 indexed survivorTokenId, uint256 indexed survivorTokenIdSeed, uint256[] tokenIds, uint16 points, uint8 resultBodyType, bool resultIsAngel, uint8 boostChance, uint64 revealBlock, bytes32 selectionHash)',
];
const BURN_FINALIZED_ABI = [
  'event BurnFinalized(uint256 indexed survivorTokenId, uint256 indexed survivorTokenIdSeed, uint256 burnSeed, uint16 points, uint8 resultBodyType, bool resultIsAngel, uint8 boostChance)',
];


// Resolves either a human-readable type string ('Human', 'Zombie') OR
// a numeric E_1_Type value (0-11) to the display name.
// normalizeOcasType alone returns 'Type NaN' when given a string like 'Human'.
function resolveOcasType(raw){
  if(raw === null || raw === undefined || raw === '') return null;
  const str = String(raw).trim().replace(/^"|"$/g, '');
  // Base type names — return as-is
  const KNOWN = ['Human','Zombie','Ape','Skeleton','Alien','Radioactive','Demonic','Angel'];
  if(KNOWN.includes(str)) return str;
  // 'Human 1', 'Human 4' etc — strip the numeric suffix
  for(const base of KNOWN){ if(str.startsWith(base + ' ') || str.startsWith(base + '\u00a0')) return base; }
  // Numeric E_1_Type — delegate to normalizeOcasType
  const n = Number(str);
  if(Number.isFinite(n)) return normalizeOcasType(n);
  return null;
}
module.exports = {
  BURN_ALERT_CHANNEL_ID, BURN_BACKFILL_ALERTS, BURN_METADATA_REFRESH_ENABLED,
  BURN_COLORS, E1_TYPE_NAMES,
  burnTypeLabel, burnTypeColor, burnTypeEmoji, normalizeOcasType, resolveOcasType,
  TOPIC_BURN_STARTED, TOPIC_BURN_FINALIZED,
  BURN_STARTED_ABI, BURN_FINALIZED_ABI,
};