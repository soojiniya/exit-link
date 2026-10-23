from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"
    service: Literal["EXIT-LINK"] = "EXIT-LINK"
    stage: Literal[1] = 1
    data_mode: Literal["simulation"] = "simulation"


@router.get("/health", response_model=HealthResponse, tags=["health"])
def health() -> HealthResponse:
    """Process liveness only; no node or TCP readiness claim."""
    return HealthResponse()
