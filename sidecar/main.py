# OSRS Flip Assistant -- Python sidecar (DESIGN.md §11.1, §11.3.1).
#
# Node/TS stays the core backend (Fastify, port 3001); this process exists only for the handful
# of things that genuinely need Python -- PRAW (Reddit) and a Discord self-bot scraper, neither
# of which has a maintained Node equivalent. Runs standalone on its own port (8000 by default);
# the Node backend polls /health (backend/src/sidecar.ts) but never depends on it being up --
# every feature this feeds (Reddit sentiment, Discord mentions) is additive, not load-bearing.

from fastapi import FastAPI, HTTPException

from config import get_config

app = FastAPI(title="OSRS Flip Assistant Sidecar")


@app.get("/health")
def health():
    config = get_config()
    return {
        "status": "ok",
        "reddit_configured": config.reddit_configured,
        "discord_configured": config.discord_configured,
    }


@app.post("/collect/reddit")
def collect_reddit_route():
    config = get_config()
    if not config.reddit_configured:
        raise HTTPException(status_code=501, detail="Reddit not configured -- see DESIGN.md §6.4")
    from collectors.reddit import collect_reddit

    try:
        return {"items": collect_reddit(subreddits=["2007scape", "RunescapeFlipping"], keywords=[])}
    except NotImplementedError as e:
        raise HTTPException(status_code=501, detail=str(e))


@app.post("/collect/discord")
def collect_discord_route():
    config = get_config()
    if not config.discord_configured:
        raise HTTPException(status_code=501, detail="Discord not configured -- see DESIGN.md §11.3.1")
    from collectors.discord_selfbot import collect_discord

    try:
        return {"items": collect_discord(channel_ids=[])}
    except NotImplementedError as e:
        raise HTTPException(status_code=501, detail=str(e))
