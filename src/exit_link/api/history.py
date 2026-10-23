"""Read-only durable history. Existing live endpoints retain their semantics."""
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request

from exit_link.api.contracts import ApiError
from exit_link.api.security import fail, require_local
from exit_link.storage.archive import StorageUnavailable
from exit_link.storage.models import (ArchiveEventPage, ComparisonPage, ControlHistoryPage,
    DeliveryHistoryPage, ExperimentHistory, ExperimentPage, StorageStatus)

router = APIRouter(prefix="/api/v1/history", tags=["persistent history"], dependencies=[Depends(require_local)],
                   responses={code: {"model": ApiError} for code in (403,404,503)})


async def query(request, operation, **params):
    try:
        return await request.app.state.backend.archive.query(operation, **params)
    except StorageUnavailable as exc:
        fail("storage_unavailable", str(exc), 503)


@router.get("/status", response_model=StorageStatus)
async def status(request: Request):
    return request.app.state.backend.archive.status()


@router.get("/experiments", response_model=ExperimentPage)
async def experiments(request: Request, cursor: int | None = Query(default=None, ge=1), limit: int = Query(default=50, ge=1,le=100)):
    return await query(request,"experiments",cursor=cursor,limit=limit)


@router.get("/comparison", response_model=ComparisonPage)
async def comparison(request: Request, experiment_id: list[UUID] = Query(min_length=1,max_length=20)):
    return await query(request,"comparison",experiment_ids=list(dict.fromkeys(map(str,experiment_id))))


@router.get("/experiments/{experiment_id}", response_model=ExperimentHistory)
async def detail(experiment_id: UUID, request: Request):
    result = await query(request,"detail",experiment_id=str(experiment_id))
    if result is None:
        fail("experiment_history_not_found", "No recorded experiment", 404)
    return result


@router.get("/experiments/{experiment_id}/events", response_model=ArchiveEventPage)
async def events(experiment_id: UUID, request: Request, after: int = Query(default=0,ge=0),
                 limit: int = Query(default=100,ge=1,le=200), event_type: str | None = Query(default=None,max_length=64)):
    return await query(request,"events",experiment_id=str(experiment_id),after=after,limit=limit,event_type=event_type)


@router.get("/experiments/{experiment_id}/deliveries", response_model=DeliveryHistoryPage)
async def deliveries(experiment_id: UUID, request: Request, cursor: int | None = Query(default=None,ge=1),
                     limit: int = Query(default=50,ge=1,le=100)):
    return await query(request,"deliveries",experiment_id=str(experiment_id),cursor=cursor,limit=limit)


@router.get("/experiments/{experiment_id}/controls", response_model=ControlHistoryPage)
async def controls(experiment_id: UUID, request: Request, cursor: int | None = Query(default=None,ge=1),
                   limit: int = Query(default=50,ge=1,le=100)):
    return await query(request,"controls",experiment_id=str(experiment_id),cursor=cursor,limit=limit)
