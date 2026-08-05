# DESIGN.md §6.4 / §11.3 item 3: PRAW-based Reddit collector for r/2007scape + r/RunescapeFlipping.
# Not implemented yet -- needs Reddit's app pre-approval (a 2-4 week review under the 2025
# "Responsible Builder Policy") before there's anything to authenticate a PRAW client with. This
# module exists so config.py's reddit_configured flag and the /collect/reddit route already have
# a real function to call once that approval comes through, instead of needing a fresh migration.

from config import get_config


def collect_reddit(subreddits: list[str], keywords: list[str]) -> list[dict]:
    config = get_config()
    if not config.reddit_configured:
        raise RuntimeError(
            "Reddit not configured -- set REDDIT_CLIENT_ID/REDDIT_CLIENT_SECRET/REDDIT_USER_AGENT"
        )
    # TODO once app-approved credentials exist: praw.Reddit(client_id=..., client_secret=...,
    # user_agent=...).subreddit("+".join(subreddits)).new(limit=...), filter by `keywords`
    # (tracked item names), hand matches to the Node backend's Claude integration (§9) for
    # entity/sentiment extraction, store mention counts in the DuckDB warehouse's
    # attention_metrics table (backend/src/warehouse.ts).
    raise NotImplementedError("Reddit collection not implemented yet -- pending app approval, see DESIGN.md §6.4")
