'use strict';

// ── Stackers strategy optimizer ────────────────────────────────────────────────
// Given a set of tokens (each at a current tier) and a $STACK budget, searches
// for a strong allocation of that budget across activating, upgrading, and
// fusing to maximize total resulting weight -- which is what actually
// determines earnings share, since every hour's fee pot is split across the
// whole collection proportional to weight.
//
// Uses a greedy approach: repeatedly picks whichever available action (upgrade
// one component's tier by one step, or fuse two/three groups together at their
// current weights) gives the best weight gained per $STACK spent among actions
// that still fit the remaining budget, until no affordable action improves
// weight any further.
//
// Honest limitation, worth being direct about: greedy is not a provably
// globally-optimal solver for a problem shaped like this (a form of
// combinatorial/multiple-choice knapsack). It's a strong, well-reasoned
// strategy, verified against several hand-checked test cases -- not a
// mathematical guarantee of the single best possible allocation. Worth being
// explicit about that distinction rather than overclaiming "the best" when
// what's actually being computed is "a very good, greedily-constructed one."
//
// A real bug was caught and fixed while building this: an early version
// tracked a fused group's weight as a single cached number, which meant a
// group that had already gained a fusion bonus was still valued at its
// pre-fusion weight when the algorithm considered fusing it again --
// producing nonsensical results. Fixed by never caching a group's weight;
// it's always recomputed live from its actual component tiers via
// groupWeight(), the same fix pattern used for BigInt/live-data issues
// elsewhere in this codebase tonight.

const TIER_TABLE = [
  { tier: 0, weight: 0,   cumulativeCost: 0 },       // asleep
  { tier: 1, weight: 100, cumulativeCost: 25000 },   // 1.0x, "active"
  { tier: 2, weight: 140, cumulativeCost: 75000 },   // 1.4x
  { tier: 3, weight: 190, cumulativeCost: 150000 },  // 1.9x
  { tier: 4, weight: 250, cumulativeCost: 300000 },  // 2.5x
  { tier: 5, weight: 350, cumulativeCost: 850000 },  // 3.5x
];

function upgradeCost(fromTier, toTier){
  if(toTier <= fromTier) return 0;
  return TIER_TABLE[toTier].cumulativeCost - TIER_TABLE[fromTier].cumulativeCost;
}
function weightAtTier(tier){ return TIER_TABLE[tier].weight; }

// A group's real current weight, always recomputed from its actual
// components rather than cached -- see the module-level note above for why
// this specific choice matters.
function groupWeight(group){
  const sum = group.components.reduce((s, c) => s + weightAtTier(c.tier), 0);
  return Math.round(sum * group.bonusMultiplier);
}

// tokens: [{ id, tier }], tier 0 = asleep/not yet activated
function optimize(tokens, budgetStack){
  let groups = tokens.map(t => ({
    id: t.id,
    components: [{ id: t.id, tier: t.tier }],
    bonusMultiplier: 1.0,
  }));
  let remainingBudget = budgetStack;
  const actionsTaken = [];

  while(true){
    let bestAction = null;
    let bestRatio = -1;

    // Candidate: upgrade one component's tier by one step. Works
    // identically whether it's an unfused token, a fusion survivor's own
    // tier, or an absorbed part via Reforge -- all three are priced on the
    // same table per Stackers' own docs ("Paying in stages never costs
    // more than one jump"), so no need to model them separately.
    for(let gi = 0; gi < groups.length; gi++){
      const group = groups[gi];
      const currentWeight = groupWeight(group);
      for(let ci = 0; ci < group.components.length; ci++){
        const comp = group.components[ci];
        if(comp.tier >= 5) continue;
        const cost = upgradeCost(comp.tier, comp.tier + 1);
        if(cost > remainingBudget) continue;
        const newComponents = group.components.map((c, idx) => idx === ci ? { ...c, tier: c.tier + 1 } : c);
        const newWeight = Math.round(newComponents.reduce((s, c) => s + weightAtTier(c.tier), 0) * group.bonusMultiplier);
        const weightGain = newWeight - currentWeight;
        const ratio = weightGain / cost;
        if(ratio > bestRatio){
          bestRatio = ratio;
          bestAction = { type: 'upgrade', groupIndex: gi, componentIndex: ci, toTier: comp.tier + 1, cost, weightGain };
        }
      }
    }

    // Candidate: fuse two groups together
    for(let i = 0; i < groups.length; i++){
      for(let j = i + 1; j < groups.length; j++){
        const cost = 50000;
        if(cost > remainingBudget) continue;
        const sumWeight = groupWeight(groups[i]) + groupWeight(groups[j]);
        const newWeight = Math.round(sumWeight * 1.2);
        const weightGain = newWeight - sumWeight;
        const ratio = weightGain / cost;
        if(ratio > bestRatio){
          bestRatio = ratio;
          bestAction = { type: 'fusePair', indices: [i, j], cost, weightGain };
        }
      }
    }

    // Candidate: fuse three groups together
    for(let i = 0; i < groups.length; i++){
      for(let j = i + 1; j < groups.length; j++){
        for(let k = j + 1; k < groups.length; k++){
          const cost = 150000;
          if(cost > remainingBudget) continue;
          const sumWeight = groupWeight(groups[i]) + groupWeight(groups[j]) + groupWeight(groups[k]);
          const newWeight = Math.round(sumWeight * 1.3);
          const weightGain = newWeight - sumWeight;
          const ratio = weightGain / cost;
          if(ratio > bestRatio){
            bestRatio = ratio;
            bestAction = { type: 'fuseTriple', indices: [i, j, k], cost, weightGain };
          }
        }
      }
    }

    if(!bestAction || bestRatio <= 0) break;

    if(bestAction.type === 'upgrade'){
      const group = groups[bestAction.groupIndex];
      group.components[bestAction.componentIndex].tier = bestAction.toTier;
      actionsTaken.push({
        type: 'upgrade',
        componentId: group.components[bestAction.componentIndex].id,
        groupSurvivorId: group.id,
        toTier: bestAction.toTier,
        cost: bestAction.cost,
      });
    } else if(bestAction.type === 'fusePair' || bestAction.type === 'fuseTriple'){
      const idxs = bestAction.indices;
      const survivorGroup = groups[idxs[0]]; // first-picked = survivor, matching the protocol's own rule
      const absorbedGroups = idxs.slice(1).map(i => groups[i]);
      const bonus = bestAction.type === 'fusePair' ? 1.2 : 1.3;

      const mergedComponents = [
        ...survivorGroup.components,
        ...absorbedGroups.flatMap(g => g.components),
      ];
      const newGroup = { id: survivorGroup.id, components: mergedComponents, bonusMultiplier: bonus };

      groups = groups.filter((_, i) => !idxs.includes(i));
      groups.push(newGroup);

      actionsTaken.push({
        type: bestAction.type,
        survivorId: survivorGroup.id,
        absorbedIds: absorbedGroups.map(g => g.id),
        cost: bestAction.cost,
        resultingWeight: groupWeight(newGroup),
      });
    }

    remainingBudget -= bestAction.cost;
  }

  const totalWeight = groups.reduce((sum, g) => sum + groupWeight(g), 0);
  const totalSpent = budgetStack - remainingBudget;

  return {
    actionsTaken,
    finalState: groups.map(g => ({ id: g.id, components: g.components, bonusMultiplier: g.bonusMultiplier, weight: groupWeight(g) })),
    totalWeight,
    totalSpent,
    remainingBudget,
  };
}

module.exports = { optimize, TIER_TABLE, upgradeCost, weightAtTier, groupWeight };
