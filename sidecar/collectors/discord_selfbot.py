# DESIGN.md §11.3.1: Discord monitoring via a self-bot/scraper on a personal account or alt
# (confirmed approach -- not an official bot application; the user has explicitly accepted the
# ToS/account-action risk this carries, see §11.3.1 for the full reasoning, not revisited here).
# Not implemented yet -- needs a real account logged in and a member of specific target servers,
# which is the user's own legwork (§11.4 checklist), not something this code can do on its own.

from config import get_config


def collect_discord(channel_ids: list[int]) -> list[dict]:
    config = get_config()
    if not config.discord_configured:
        raise RuntimeError("Discord not configured -- set DISCORD_SELF_BOT_TOKEN")
    # TODO once a self-bot account/token exists: discord.py-self's Client, read message history
    # for `channel_ids` (servers/channels the account is already a member of -- same access model
    # as a human reading the channel, just automated), hand matches to the same
    # processing pipeline as collect_reddit() (Claude entity/sentiment extraction, mention counts
    # into the DuckDB warehouse's attention_metrics table, tagged source="discord").
    raise NotImplementedError("Discord collection not implemented yet -- needs a prepped self-bot account, see DESIGN.md §11.3.1")
