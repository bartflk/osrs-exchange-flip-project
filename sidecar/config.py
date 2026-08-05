import os
from dataclasses import dataclass


@dataclass
class Config:
    reddit_client_id: str | None
    reddit_client_secret: str | None
    reddit_user_agent: str | None
    discord_token: str | None

    @property
    def reddit_configured(self) -> bool:
        return bool(self.reddit_client_id and self.reddit_client_secret and self.reddit_user_agent)

    @property
    def discord_configured(self) -> bool:
        return bool(self.discord_token)


def get_config() -> Config:
    return Config(
        reddit_client_id=os.environ.get("REDDIT_CLIENT_ID"),
        reddit_client_secret=os.environ.get("REDDIT_CLIENT_SECRET"),
        reddit_user_agent=os.environ.get("REDDIT_USER_AGENT"),
        discord_token=os.environ.get("DISCORD_SELF_BOT_TOKEN"),
    )
