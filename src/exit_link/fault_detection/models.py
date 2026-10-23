"""Versioned, expiring link-state advertisements for trusted localhost peers."""
from typing import Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field

LinkStatus = Literal["unknown", "up", "suspect", "down"]


class Advertisement(BaseModel):
    model_config = ConfigDict(extra="forbid")
    origin: str
    epoch: int = Field(gt=0, strict=True)
    sequence: int = Field(ge=1, strict=True)
    generated_at: AwareDatetime
    links: dict[str, LinkStatus]
