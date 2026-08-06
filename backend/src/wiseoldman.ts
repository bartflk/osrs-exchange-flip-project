// DESIGN.md §14.13 / message 8 "Player Profile": Wise Old Man's public player API -- confirmed
// live via `curl -H "User-Agent: ..." https://api.wiseoldman.net/v2/players/Zezima` before
// building against it, not guessed from memory. No API key needed for this endpoint, but WOM
// requires a descriptive User-Agent (a generic/default one gets blocked) -- see their docs.
const BASE_URL = "https://api.wiseoldman.net/v2";
const USER_AGENT = "osrs-flip-assistant/1.0 (local single-user GE flip tool)";

interface WomSkillEntry {
  metric: string;
  experience: number;
  rank: number;
  level: number;
  ehp: number;
}

interface WomBossEntry {
  metric: string;
  kills: number;
  rank: number;
  ehb: number;
}

interface WomPlayerResponse {
  username: string;
  displayName: string;
  type: string;
  combatLevel: number;
  updatedAt: string;
  latestSnapshot: {
    data: {
      skills: Record<string, WomSkillEntry>;
      bosses: Record<string, WomBossEntry>;
    };
  } | null;
}

export interface SkillLevel {
  level: number;
  experience: number;
}

export interface BossKills {
  kills: number;
}

export interface PlayerSnapshot {
  username: string;
  displayName: string;
  type: string;
  combatLevel: number;
  updatedAt: string;
  // -1 experience/rank/kills from WOM means "unranked / never recorded" -- normalized to 0 here
  // so the frontend and the future session-planner filter (Phase 3) don't need to special-case
  // WOM's sentinel value.
  skills: Record<string, SkillLevel>;
  bosses: Record<string, BossKills>;
}

export class PlayerNotFoundError extends Error {}

export async function getPlayerSnapshot(username: string): Promise<PlayerSnapshot> {
  const res = await fetch(`${BASE_URL}/players/${encodeURIComponent(username)}`, {
    headers: { "User-Agent": USER_AGENT },
  });

  if (res.status === 404) {
    throw new PlayerNotFoundError(`Player "${username}" not found on Wise Old Man`);
  }
  if (!res.ok) {
    throw new Error(`Wise Old Man API returned ${res.status}`);
  }

  const data = (await res.json()) as WomPlayerResponse;
  const skillsRaw = data.latestSnapshot?.data.skills ?? {};
  const bossesRaw = data.latestSnapshot?.data.bosses ?? {};

  const skills: Record<string, SkillLevel> = {};
  for (const [name, s] of Object.entries(skillsRaw)) {
    skills[name] = { level: Math.max(1, s.level), experience: Math.max(0, s.experience) };
  }
  const bosses: Record<string, BossKills> = {};
  for (const [name, b] of Object.entries(bossesRaw)) {
    bosses[name] = { kills: Math.max(0, b.kills) };
  }

  return {
    username: data.username,
    displayName: data.displayName,
    type: data.type,
    combatLevel: data.combatLevel,
    updatedAt: data.updatedAt,
    skills,
    bosses,
  };
}
