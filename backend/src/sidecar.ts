// DESIGN.md §11.3.1 / §11.4: the Node backend never depends on the Python sidecar being up --
// every feature it feeds (Reddit sentiment, Discord mentions) is additive. This is just a status
// check with a short timeout so /api/status can report whether it's running, without ever
// blocking the main app on it.
const SIDECAR_URL = process.env.SIDECAR_URL ?? "http://127.0.0.1:8000";

export interface SidecarStatus {
  running: boolean;
  redditConfigured: boolean;
  discordConfigured: boolean;
}

export async function getSidecarStatus(): Promise<SidecarStatus> {
  try {
    const res = await fetch(`${SIDECAR_URL}/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return { running: false, redditConfigured: false, discordConfigured: false };
    const body = (await res.json()) as { reddit_configured: boolean; discord_configured: boolean };
    return {
      running: true,
      redditConfigured: body.reddit_configured,
      discordConfigured: body.discord_configured,
    };
  } catch {
    return { running: false, redditConfigured: false, discordConfigured: false };
  }
}
