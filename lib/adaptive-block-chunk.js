'use strict';

// ── Adaptive eth_getLogs chunk sizer ──────────────────────────────────────────
// The 10-block chunk size used by every Robinhood Chain poller in this repo
// (lib/stackers-fusion-poller.js, lib/stackers-status-poller.js) was copied
// directly from OCAS's Ethereum burn-poller, where it was confirmed as a real
// Alchemy account-level eth_getLogs range cap on THAT account/network. It was
// never actually verified on Robinhood Chain — carried over defensively,
// "better safe than sorry." Since Robinhood Chain produces blocks far faster
// than Ethereum (confirmed ~598 blocks/minute via these pollers' own
// comments), a 10-block chunk can't realistically keep up even running
// continuously, let alone on an hourly safety-net cadence — this is the
// direct cause of the "still catching up — ~1.4M blocks behind" backlog that
// only ever grows.
//
// Rather than guessing a new fixed number (risking either "still too small"
// or "too large, every request now fails"), this starts optimistic and
// shrinks automatically the moment a request is actually rejected for being
// too large — so the real ceiling gets discovered empirically instead of
// assumed in either direction. Never grows back up automatically within a
// process lifetime (kept simple deliberately); a restart re-attempts the
// optimistic starting size, which is a fine, self-correcting pattern on its
// own given how infrequently these processes restart.

const RANGE_ERROR_PATTERNS = [
  /range/i, /too large/i, /too many/i, /limit/i, /exceeds/i, /max.*block/i, /block.*max/i,
];

function looksLikeRangeError(err){
  const msg = String(err?.message || err || '');
  return RANGE_ERROR_PATTERNS.some(p => p.test(msg));
}

class AdaptiveChunkSizer {
  constructor({ initial, floor = 10, label = 'chunk' }){
    this.size = initial;
    this.floor = floor;
    this.label = label;
  }

  // Called after a request fails with what looks like a range-too-large
  // error. Halves the chunk size (never below floor) and logs the change.
  // Returns true if the size actually changed (worth retrying), false if
  // already at the floor (nothing more this sizer can do — the caller
  // should treat this as a genuine, non-range-related failure).
  shrink(){
    if(this.size <= this.floor) return false;
    const prev = this.size;
    this.size = Math.max(this.floor, Math.floor(this.size / 2));
    console.warn(`[AdaptiveChunk:${this.label}] Range rejected at ${prev} blocks — reducing to ${this.size} and retrying`);
    return this.size !== prev;
  }
}

module.exports = { AdaptiveChunkSizer, looksLikeRangeError };
