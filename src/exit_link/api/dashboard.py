"""Versioned REST and read-only WebSocket adapter; no frontend code."""
import asyncio
from contextlib import suppress
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request, WebSocket, WebSocketDisconnect

from exit_link.api.contracts import (ApiError, BackendSnapshot, BuildingView, EventPage, ExperimentView,
    GuidanceSend, HazardReplace, NetworkView, PlanRequest, ScenarioCreate, SnapshotFrame)
from exit_link.api.security import fail, local_connection, require_local, require_write
from exit_link.evacuation.dashboard import FloorView
from exit_link.evacuation.models import EvacuationPlan, HazardUpdate, ScenarioSnapshot
from exit_link.evacuation.transport import GuidanceDelivery

router = APIRouter(prefix="/api/v1", dependencies=[Depends(require_local)], responses={
    code: {"model": ApiError} for code in (400, 403, 404, 409, 422, 429, 503)})
write = [Depends(require_write)]


@router.get("/building", response_model=BuildingView, tags=["building"])
async def building(request: Request):
    return request.app.state.backend.building_view()


@router.get("/building/floors/{floor}", response_model=FloorView, tags=["building"])
async def floor(floor: int, request: Request):
    result = next((f for f in request.app.state.backend.building_view().floors if f.floor == floor), None)
    if result is None:
        fail("floor_not_found", "Unknown building floor", 404)
    return result


@router.get("/snapshot", response_model=BackendSnapshot, tags=["state"])
async def snapshot(request: Request):
    return request.app.state.backend.snapshot()


@router.get("/network", response_model=NetworkView, tags=["network"])
async def network(request: Request):
    return request.app.state.backend.network


@router.post("/network/refresh", response_model=NetworkView, dependencies=write, tags=["network"])
async def refresh_network(request: Request):
    return await request.app.state.backend.refresh_network()


@router.get("/scenarios", response_model=list[ScenarioSnapshot], tags=["scenarios"])
async def scenarios(request: Request):
    return [session.snapshot() for session in request.app.state.backend.sessions.values()]


@router.post("/scenarios", response_model=ScenarioSnapshot, status_code=201, dependencies=write, tags=["scenarios"])
async def create_scenario(body: ScenarioCreate, request: Request):
    return request.app.state.backend.create_scenario(body)


@router.get("/scenarios/{scenario_id}", response_model=ScenarioSnapshot, tags=["scenarios"])
async def scenario(scenario_id: UUID, request: Request):
    return request.app.state.backend.session(scenario_id).snapshot()


@router.get("/scenarios/{scenario_id}/hazards", response_model=HazardUpdate, tags=["scenarios"])
async def hazards(scenario_id: UUID, request: Request):
    return request.app.state.backend.session(scenario_id).state.hazards


@router.put("/scenarios/{scenario_id}/hazards", response_model=ScenarioSnapshot, dependencies=write, tags=["scenarios"])
async def replace_hazards(scenario_id: UUID, body: HazardReplace, request: Request):
    return request.app.state.backend.replace_hazards(scenario_id, body)


@router.get("/scenarios/{scenario_id}/plans", response_model=list[EvacuationPlan], tags=["routes"])
async def plans(scenario_id: UUID, request: Request):
    return request.app.state.backend.session(scenario_id).snapshot().plans


@router.post("/scenarios/{scenario_id}/plans", response_model=EvacuationPlan, dependencies=write, tags=["routes"])
async def plan(scenario_id: UUID, body: PlanRequest, request: Request):
    return request.app.state.backend.plan(scenario_id, body.start_location)


@router.post("/scenarios/{scenario_id}/guidance", response_model=GuidanceDelivery, dependencies=write, tags=["guidance"])
async def send(scenario_id: UUID, body: GuidanceSend, request: Request):
    return await request.app.state.backend.deliver(scenario_id, body)


@router.get("/deliveries", response_model=list[GuidanceDelivery], tags=["guidance"])
async def deliveries(request: Request, scenario_id: UUID | None = None):
    return [d for d in request.app.state.backend.deliveries if scenario_id is None or d.scenario_id == scenario_id]


@router.get("/deliveries/{message_id}", response_model=GuidanceDelivery, tags=["guidance"])
async def delivery(message_id: UUID, request: Request):
    result = next((d for d in request.app.state.backend.deliveries if d.message_id == message_id), None)
    if result is None:
        fail("delivery_not_found", "Delivery is absent or outside the 512-result retention window", 404)
    return result


@router.get("/experiment", response_model=ExperimentView, tags=["experiments"])
async def experiment(request: Request):
    return request.app.state.backend.experiment_view()


@router.post("/experiment", response_model=ExperimentView, dependencies=write, tags=["experiments"])
async def start_experiment(request: Request):
    return await request.app.state.backend.start_experiment()


@router.delete("/experiment", response_model=ExperimentView, dependencies=write, tags=["experiments"])
async def stop_experiment(request: Request):
    request.app.state.backend.require_experiment()
    return await request.app.state.backend.stop_experiment()


@router.post("/experiment/nodes/{node_id}/fail", response_model=ExperimentView, dependencies=write, tags=["experiments"])
async def fail_node(node_id: str, request: Request):
    return await request.app.state.backend.control_node(node_id)


@router.post("/experiment/nodes/{node_id}/recover", response_model=ExperimentView, dependencies=write, tags=["experiments"])
async def recover_node(node_id: str, request: Request):
    return await request.app.state.backend.control_node(node_id, recover=True)


@router.get("/events", response_model=EventPage, tags=["events"])
async def events(request: Request, stream_id: UUID, after: int = Query(ge=0)):
    return request.app.state.backend.bus.replay(stream_id, after)


ws_router = APIRouter()


@ws_router.websocket("/ws/v1/events")
async def websocket_events(socket: WebSocket):
    if not local_connection(socket):
        await socket.close(code=1008)
        return
    backend = socket.app.state.backend
    try:
        # No await between subscription and snapshot: baseline and subsequent events are consistent.
        queue = backend.bus.subscribe()
        initial = SnapshotFrame(payload=backend.snapshot()).model_dump(mode="json")
    except RuntimeError:
        await socket.close(code=1013)
        return
    tasks = []
    try:
        await socket.accept()
        await socket.send_json(initial)

        async def writer():
            while True:
                event = await queue.get()
                if event is None:
                    await socket.close(code=1013, reason="Event backlog exceeded; reconnect for snapshot")
                    return
                await socket.send_json(event.model_dump(mode="json"))

        async def reader():
            while True:
                incoming = await socket.receive()
                if incoming["type"] == "websocket.disconnect":
                    return
                # Read-only channel: no commands or unbounded incoming messages.
                await socket.close(code=1008, reason="Read-only event stream")
                return

        tasks = [asyncio.create_task(writer()), asyncio.create_task(reader())]
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    except WebSocketDisconnect:
        pass
    finally:
        backend.bus.clients.discard(queue)
        for task in tasks:
            task.cancel()
        for task in tasks:
            with suppress(asyncio.CancelledError, WebSocketDisconnect, RuntimeError):
                await task
