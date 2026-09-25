// lib/trait-pulse.js
//
// "Trait Pulse" -- jv: "What traits are actually moving right now?" Ranks
// every trait/value combination in a collection by how UNUSUAL its recent
// activity is, not by raw sale count. A common trait (Black Background,
// 1,800 supply) racking up 10 sales/hour is often just its normal baseline
// rate; a rare trait (Gold Fur, 90 supply) doing 4 sales/hour against a
// baseline of maybe 1/hour is a real, unusual burst -- even though its raw
// count is smaller. Comparing a trait's current-window sales to its OWN
// historical rate (rather than dividing by supply directly) already
// captures this: a trait's normal sales rate implicitly reflects how many
// tokens it has, so no separate supply-normalization step is needed on top
// of it.
//
// Three signals, combined into one ranking score but always shown
// separately so the number is never a mystery:
//   - velocity_multiplier: sales in this window vs. this SAME trait's own
//     trailing 14-day rate, scaled down to the window length. Consistent
//     across all four windows (1h/6h/24h/7d) including 7d itself, which
//     compares against a 2-week trailing average rather than trivially
//     equalling ~1.0.
//   - listing_pressure_pct: how much the trait's own listed supply has
//     fallen since the window started (positive = being bought up faster
//     than relisted).
//   - floor_change_pct: trait floor now vs. trait floor at window start.
//
// Confidence gating (the "don't manufacture trends out of noise" jv
// specifically called out): a trait/value is excluded entirely from a
// window's results if its total supply or its sales count in that window
// falls below a minimum -- not scored at zero, not shown with a caveat,
// just absent. Listing-pressure and floor-change are separately treated as
// unavailable (null, excluded from the score) rather than zero whenever
// too few tokens are listed to trust a percentage computed from them.

const WINDOWS = [
  { key: '1h',  hours: 1 },
  { key: '6h',  hours: 6 },
  { key: '24h', hours: 24 },
  { key: '7d',  hours: 168 },
];
const BASELINE_HOURS = 336; // 14-day trailing reference period for every window's baseline
const MIN_SUPPLY = 5;            // exclude near-1-of-1 trait/value combos entirely
const MIN_SALES_ABS = 2;         // exclude a window's result if fewer than this many sales
const MIN_LISTED_FOR_SIGNAL = 2; // listing-pressure/floor-change need at least this many listed, both then and now, to count
const MIN_BASELINE_EXPECTED = 0.25; // floor for baseline_expected so a never-before-sold trait's first sale doesn't produce an undefined/absurd multiplier

async function computeTraitPulse(pool, slug){
  const lcSlug = String(slug || '').toLowerCase();
  if(!lcSlug) return { ok: false, reason: 'missing-slug' };

  try{
    // ── Step 1: snapshot current listed_count + trait_floor per trait/value ──
    // Insert unconditionally each run (not upsert) -- these accumulate as a
    // time series so a later run can find "the snapshot closest to N hours
    // ago"; pruned at the end of this function.
    await pool.query(`
      INSERT INTO trait_pulse_snapshots (collection_slug, trait_name, trait_value, listed_count, trait_floor_eth)
      SELECT tt.collection_slug, tt.trait_name, tt.trait_value,
             COUNT(DISTINCT l.token_id) AS listed_count,
             MIN(l.price_eth) AS trait_floor_eth
      FROM token_traits tt
      LEFT JOIN listings l ON l.token_id = tt.token_id AND l.collection_slug = tt.collection_slug
      WHERE tt.collection_slug = $1
      GROUP BY tt.collection_slug, tt.trait_name, tt.trait_value
    `, [lcSlug]);

    // ── Step 2: supply per trait/value ──────────────────────────────────────
    const supplyRes = await pool.query(`
      SELECT trait_name, trait_value, COUNT(DISTINCT token_id) AS supply
      FROM token_traits
      WHERE collection_slug = $1
      GROUP BY trait_name, trait_value
    `, [lcSlug]);
    const supplyMap = new Map(); // "name::value" -> supply
    for(const r of supplyRes.rows) supplyMap.set(`${r.trait_name}::${r.trait_value}`, parseInt(r.supply));

    // ── Step 3: sales in each window + the shared 14-day baseline, one pass ──
    // FILTER (WHERE ...) lets every window's count come from a single scan
    // of the trailing 14 days, rather than one query per window.
    const filterCols = WINDOWS.map((w) =>
      `COUNT(*) FILTER (WHERE s.sale_ts >= NOW() - INTERVAL '${w.hours} hours') AS sales_${w.key.replace(/[^a-z0-9]/g,'')}`
    ).join(',\n      ');
    const salesRes = await pool.query(`
      SELECT tt.trait_name, tt.trait_value,
        ${filterCols},
        COUNT(*) AS sales_14d
      FROM sales s
      JOIN token_traits tt ON tt.token_id = s.token_id AND tt.collection_slug = s.collection_slug
      WHERE s.collection_slug = $1 AND s.sale_ts >= NOW() - INTERVAL '${BASELINE_HOURS} hours'
      GROUP BY tt.trait_name, tt.trait_value
    `, [lcSlug]);
    const salesMap = new Map(); // "name::value" -> { sales_1h, sales_6h, sales_24h, sales_7d, sales_14d }
    for(const r of salesRes.rows){
      const rec = { sales_14d: parseInt(r.sales_14d) };
      for(const w of WINDOWS) rec[`sales_${w.key}`] = parseInt(r[`sales_${w.key.replace(/[^a-z0-9]/g,'')}`] || 0);
      salesMap.set(`${r.trait_name}::${r.trait_value}`, rec);
    }

    // ── Step 4: current snapshot + one "prior" snapshot per window ──────────
    const currentRes = await pool.query(`
      SELECT DISTINCT ON (trait_name, trait_value) trait_name, trait_value, listed_count, trait_floor_eth
      FROM trait_pulse_snapshots
      WHERE collection_slug = $1
      ORDER BY trait_name, trait_value, snapshot_at DESC
    `, [lcSlug]);
    const currentMap = new Map();
    for(const r of currentRes.rows) currentMap.set(`${r.trait_name}::${r.trait_value}`, {
      listed_count: parseInt(r.listed_count), trait_floor_eth: r.trait_floor_eth != null ? parseFloat(r.trait_floor_eth) : null
    });

    const priorMapByWindow = new Map(); // window_key -> Map("name::value" -> {listed_count, trait_floor_eth})
    for(const w of WINDOWS){
      const priorRes = await pool.query(`
        SELECT DISTINCT ON (trait_name, trait_value) trait_name, trait_value, listed_count, trait_floor_eth
        FROM trait_pulse_snapshots
        WHERE collection_slug = $1 AND snapshot_at <= NOW() - INTERVAL '${w.hours} hours'
        ORDER BY trait_name, trait_value, snapshot_at DESC
      `, [lcSlug]);
      const m = new Map();
      for(const r of priorRes.rows) m.set(`${r.trait_name}::${r.trait_value}`, {
        listed_count: parseInt(r.listed_count), trait_floor_eth: r.trait_floor_eth != null ? parseFloat(r.trait_floor_eth) : null
      });
      priorMapByWindow.set(w.key, m);
    }

    // ── Step 5: compute per trait/value per window, upsert only the ones ────
    //    that pass the confidence gate.
    const rowsToUpsert = [];
    for(const [key, supply] of supplyMap){
      if(supply < MIN_SUPPLY) continue; // confidence gate: too small a trait to ever rank
      const [traitName, traitValue] = key.split('::');
      const sales = salesMap.get(key);
      if(!sales) continue; // zero sales in the 14-day lookback window at all
      const current = currentMap.get(key) || { listed_count: 0, trait_floor_eth: null };

      for(const w of WINDOWS){
        const salesCount = sales[`sales_${w.key}`] || 0;
        if(salesCount < MIN_SALES_ABS) continue; // confidence gate: not enough activity to mean anything

        const baselineExpectedRaw = (sales.sales_14d || 0) * (w.hours / BASELINE_HOURS);
        const baselineExpected = Math.max(baselineExpectedRaw, MIN_BASELINE_EXPECTED);
        const velocityMultiplier = salesCount / baselineExpected;

        const prior = priorMapByWindow.get(w.key)?.get(key) || null;
        let listingPressurePct = null;
        if(prior && prior.listed_count >= MIN_LISTED_FOR_SIGNAL && current.listed_count >= MIN_LISTED_FOR_SIGNAL){
          listingPressurePct = ((prior.listed_count - current.listed_count) / prior.listed_count) * 100;
        }
        let floorChangePct = null;
        if(prior && prior.trait_floor_eth != null && current.trait_floor_eth != null
           && prior.listed_count >= MIN_LISTED_FOR_SIGNAL && current.listed_count >= MIN_LISTED_FOR_SIGNAL
           && prior.trait_floor_eth > 0){
          floorChangePct = ((current.trait_floor_eth - prior.trait_floor_eth) / prior.trait_floor_eth) * 100;
        }

        const heatScore = velocityMultiplier
          * (1 + Math.max(0, listingPressurePct || 0) / 100)
          * (1 + Math.max(0, floorChangePct || 0) / 100);

        rowsToUpsert.push([
          lcSlug, traitName, traitValue, w.key, supply, salesCount,
          baselineExpected, velocityMultiplier,
          current.listed_count, prior?.listed_count ?? null, listingPressurePct,
          current.trait_floor_eth, prior?.trait_floor_eth ?? null, floorChangePct,
          heatScore
        ]);
      }
    }

    // Clear this collection's prior cache entirely and re-insert fresh --
    // simpler and safer than reconciling which trait/value combos should no
    // longer appear (e.g., one that no longer meets the confidence gate this
    // run) against a partial upsert.
    await pool.query(`DELETE FROM trait_pulse_cache WHERE collection_slug = $1`, [lcSlug]);
    if(rowsToUpsert.length){
      const cols = 15;
      const vals = rowsToUpsert.map((_, i) => `(${Array.from({length: cols}, (_, j) => `$${i*cols+j+1}`).join(',')})`).join(',\n');
      await pool.query(`
        INSERT INTO trait_pulse_cache (
          collection_slug, trait_name, trait_value, window_key, supply, sales_count,
          baseline_expected, velocity_multiplier,
          listed_count, listed_count_prior, listing_pressure_pct,
          trait_floor_eth, trait_floor_eth_prior, floor_change_pct,
          heat_score
        ) VALUES ${vals}
      `, rowsToUpsert.flat());
    }

    // ── Prune snapshots older than the longest window's lookback needs ──────
    // (7d window's "prior" search goes back 7 days; keep a little slack)
    await pool.query(`DELETE FROM trait_pulse_snapshots WHERE collection_slug = $1 AND snapshot_at < NOW() - INTERVAL '9 days'`, [lcSlug]);

    return { ok: true, slug: lcSlug, rowsComputed: rowsToUpsert.length };
  }catch(e){
    console.error(`[TraitPulse] [${lcSlug}] compute failed:`, e.message);
    return { ok: false, reason: 'error', error: e.message };
  }
}

module.exports = { computeTraitPulse, WINDOWS };
