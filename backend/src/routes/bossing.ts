import type { FastifyInstance } from "fastify";
import { findMonster, gameDataCacheState, getMonsters } from "../gameData.js";
import { bestLoadoutAllStyles } from "../gearOptimizer.js";
import type { PlayerSkills } from "../dps.js";
import {
  attachMoneyMakerImages,
  getPricedMoneyMakers,
  moneyMakerCount,
  refreshMoneyMakers,
  type PricedMoneyMaker,
} from "../moneyMaking.js";
import { getPlayerSnapshot } from "../wiseoldman.js";
import { getStrategySetups } from "../strategySetups.js";
import { computeSetupDps, type SetupDpsResult } from "../setupDps.js";

// Money makers, ranked by gp/hr computed from live prices, gated by what the player can actually
// do -- their real skill levels and their real bankroll.

const DEFAULT_SKILLS: PlayerSkills = {
  attack: 99,
  strength: 99,
  defence: 99,
  ranged: 99,
  magic: 99,
  hitpoints: 99,
  prayer: 99,
};

/**
 * Which activities the player meets the requirements for.
 *
 * `null` levels mean no player is configured, in which case nothing is filtered out and nothing
 * is claimed to be met -- an unknown requirement must not read as a satisfied one.
 */
function evaluateRequirements(
  guide: PricedMoneyMaker,
  levels: Record<string, number> | null,
): { met: boolean | null; missing: { skill: string; needed: number; have: number }[] } {
  if (!levels) return { met: null, missing: [] };
  const missing = guide.requirements
    .map((r) => ({ skill: r.skill, needed: r.level, have: levels[r.skill] ?? 1 }))
    .filter((r) => r.have < r.needed);
  return { met: missing.length === 0, missing };
}

export async function bossingRoutes(app: FastifyInstance) {
  // The wiki's own inventory setups for a boss, priced live. On demand rather than bundled into
  // /api/money-makers: only a fraction of the 639 guides have a Strategies page, and scraping
  // them all to answer a question about one row would be hundreds of wasted requests.
  app.get("/api/strategy-setups", async (req, reply) => {
    const { activity, monster, bankroll, username } = req.query as {
      activity?: string;
      monster?: string;
      bankroll?: string;
      username?: string;
    };
    if (!activity) return reply.code(400).send({ error: "activity is required" });

    let result;
    try {
      result = await getStrategySetups(activity);
    } catch (err) {
      // A missing or restructured wiki page must not surface as a broken panel. The caller
      // renders nothing for an empty result, which is the correct outcome for a boss that has
      // no documented setup anyway.
      req.log.error({ err, activity }, "strategy setups failed");
      return { page: null, setups: [] };
    }
    if (result.setups.length === 0) return result;

    // DPS is scored for the setup the wiki actually recommends, not for a free search over every
    // item in the game. The optimiser's answer at the Doom of Mokhaiotl was a Webweaver bow, which
    // nobody takes there -- raw DPS against a stationary dummy is not what picks a loadout for a
    // fight with phases and a melee punish, and the wiki's setups already encode that judgement.
    const target = monster ? await findMonster(monster) : null;
    if (!target) return result;

    let skills = DEFAULT_SKILLS;
    let levelsKnown = false;
    if (username) {
      try {
        const snap = await getPlayerSnapshot(username);
        const lvl = (n: string, fallback: number) => snap.skills[n]?.level ?? fallback;
        skills = {
          attack: lvl("attack", 1),
          strength: lvl("strength", 1),
          defence: lvl("defence", 1),
          ranged: lvl("ranged", 1),
          magic: lvl("magic", 1),
          hitpoints: lvl("hitpoints", 10),
          prayer: lvl("prayer", 1),
        };
        levelsKnown = true;
      } catch {
        levelsKnown = false;
      }
    }

    const budget = Number(bankroll);
    const analysis: (SetupDpsResult & { variant: string })[] = [];
    for (const setup of result.setups) {
      // Spare is measured against THIS setup: the money left once you own it. On a Budget setup
      // that is most of the bankroll and the suggestions are real; on a max setup it is usually
      // nothing, and offering upgrades you cannot fund would be noise.
      const spare = Number.isFinite(budget) ? Math.max(0, budget - setup.cost) : 0;
      try {
        analysis.push({
          variant: setup.variant,
          ...(await computeSetupDps(setup, target, skills, spare)),
        });
      } catch (err) {
        req.log.warn({ err, variant: setup.variant }, "setup dps failed");
      }
    }

    return {
      ...result,
      monster: { name: target.name, hp: target.skills.hp, defence: target.skills.def },
      levelsKnown,
      analysis,
    };
  });

  app.get("/api/money-makers", async (req) => {
    const { username, bankroll, membersOnly } = req.query as {
      username?: string;
      bankroll?: string;
      membersOnly?: string;
    };

    let levels: Record<string, number> | null = null;
    let player: string | null = null;
    if (username) {
      try {
        const snapshot = await getPlayerSnapshot(username);
        levels = Object.fromEntries(
          Object.entries(snapshot.skills).map(([k, v]) => [k.toLowerCase(), v.level]),
        );
        player = snapshot.displayName;
      } catch {
        // A bad or unreachable username must not empty the page. Requirements simply go unknown.
        levels = null;
      }
    }

    const budget = Number(bankroll);
    const priced = getPricedMoneyMakers();
    // Icons are decoration, so a wiki hiccup must not cost the caller its data. Failing here
    // would turn a missing picture into a missing money-maker list.
    try {
      await attachMoneyMakerImages(priced);
    } catch (err) {
      req.log.warn({ err }, "wiki image resolution failed, rendering without icons");
    }
    const guides = priced
      .filter((g) => (membersOnly === "false" ? !g.members : true))
      .map((g) => {
        const req = evaluateRequirements(g, levels);
        return {
          ...g,
          requirementsMet: req.met,
          missingRequirements: req.missing,
          // Startup capital is the hour's inputs. A guide is only actionable if you can fund a
          // cycle of it, which is a different question from whether you have the levels.
          affordable: Number.isFinite(budget) ? g.inputCost <= budget : null,
        };
      })
      // Sorted on the HEADLINE, which is the wiki's figure where one exists, so the API's order
      // matches the number the UI displays.
      .sort((a, b) => b.headlineProfitPerHour - a.headlineProfitPerHour);

    return {
      guides,
      player,
      levelsKnown: levels != null,
      total: guides.length,
      stored: moneyMakerCount(),
      gameData: gameDataCacheState(),
    };
  });

  // Slow: ~11 wiki requests plus parsing. Fired manually, and returns immediately.
  app.post("/api/money-makers/refresh", async () => {
    refreshMoneyMakers().catch((err) => app.log.error(err, "money maker refresh failed"));
    return { started: true };
  });

  app.get("/api/monsters", async (req) => {
    const { q } = req.query as { q?: string };
    const monsters = await getMonsters();
    const needle = (q ?? "").trim().toLowerCase();
    const filtered = needle
      ? monsters.filter((m) => m.name.toLowerCase().includes(needle))
      : monsters;
    return {
      total: monsters.length,
      monsters: filtered.slice(0, 60).map((m) => ({
        id: m.id,
        name: m.name,
        version: m.version,
        level: m.level,
        hp: m.skills.hp,
        defence: m.skills.def,
        attributes: m.attributes,
      })),
    };
  });

  /**
   * Best affordable loadout for one monster, at the caller's real levels and real budget.
   */
  app.get("/api/gear/best", async (req, reply) => {
    const { monster, bankroll, username, slayer } = req.query as {
      monster?: string;
      bankroll?: string;
      username?: string;
      slayer?: string;
    };
    if (!monster) return reply.code(400).send({ error: "monster name required" });

    const target = await findMonster(monster);
    if (!target) return reply.code(404).send({ error: `no monster named "${monster}"` });

    let skills = DEFAULT_SKILLS;
    let levelsKnown = false;
    let player: string | null = null;
    if (username) {
      try {
        const snap = await getPlayerSnapshot(username);
        const lvl = (name: string, fallback: number) => snap.skills[name]?.level ?? fallback;
        skills = {
          attack: lvl("attack", 1),
          strength: lvl("strength", 1),
          defence: lvl("defence", 1),
          ranged: lvl("ranged", 1),
          magic: lvl("magic", 1),
          hitpoints: lvl("hitpoints", 10),
          prayer: lvl("prayer", 1),
        };
        levelsKnown = true;
        player = snap.displayName;
      } catch {
        levelsKnown = false;
      }
    }

    const budget = Number(bankroll);
    if (!Number.isFinite(budget) || budget <= 0) {
      return reply.code(400).send({ error: "bankroll required" });
    }

    // Piety / Rigour / Augury, the standard assumption at the levels this tool is used at. Stated
    // in the response rather than hidden, since it materially changes the numbers.
    const prayers = { prayerAttack: 1.2, prayerStrength: 1.23 };

    const loadouts = await bestLoadoutAllStyles(target, skills, budget, {
      onSlayerTask: slayer === "true",
      ...prayers,
    });

    return {
      monster: {
        id: target.id,
        name: target.name,
        version: target.version,
        level: target.level,
        hp: target.skills.hp,
        defence: target.skills.def,
        attributes: target.attributes,
        defensive: target.defensive,
      },
      player,
      levelsKnown,
      skills,
      budget,
      assumedPrayers: "Piety / Rigour equivalent (x1.20 attack, x1.23 strength)",
      loadouts,
    };
  });
}
