"""Public read-only demo API. No experiment, scenario mutation, or TCP control routes."""
import os
from contextlib import asynccontextmanager
from urllib.parse import urlsplit

from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from exit_link.api.contracts import SnapshotFrame
from exit_link.api.runtime import Backend
from exit_link.api.security import ApiSettings


def configured_origin() -> str:
    origin = os.environ.get("EXIT_LINK_PUBLIC_ORIGIN", "").strip().rstrip("/")
    parsed = urlsplit(origin)
    if parsed.scheme != "https" or not parsed.hostname or parsed.path or parsed.query or parsed.fragment or parsed.username or parsed.password:
        raise ValueError("Set EXIT_LINK_PUBLIC_ORIGIN to the exact HTTPS frontend origin")
    return origin


def create_public_app() -> FastAPI:
    origin = configured_origin()
    settings = ApiSettings(control_token=None, experiments_enabled=False,
                           monitor_enabled=False, persistence_enabled=False)
    backend = Backend(settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        await backend.start()
        try:
            yield
        finally:
            await backend.close()

    app = FastAPI(title="EXIT-LINK Public Read-Only Demo", lifespan=lifespan)
    app.state.backend = backend
    app.add_middleware(CORSMiddleware, allow_origins=[origin], allow_methods=["GET"],
                       allow_headers=["Content-Type"])

    @app.get("/health")
    def health():
        return {"status": "ok", "service": "EXIT-LINK", "mode": "public_read_only"}

    @app.get("/api/v1/building")
    def building():
        return backend.building_view()

    @app.get("/api/v1/snapshot")
    def snapshot():
        return backend.snapshot()

    @app.get("/api/v1/network")
    def network():
        return backend.network

    @app.get("/api/v1/scenarios")
    def scenarios():
        return []

    @app.get("/api/v1/experiment")
    def experiment():
        return backend.experiment_view()

    @app.get("/api/v1/deliveries")
    def deliveries():
        return []

    @app.websocket("/ws/v1/events")
    async def events(socket: WebSocket):
        if socket.headers.get("origin") != origin:
            await socket.close(code=1008)
            return
        await socket.accept()
        await socket.send_json(SnapshotFrame(payload=backend.snapshot()).model_dump(mode="json"))
        try:
            while True:
                await socket.receive_text()
                await socket.close(code=1008)
                return
        except Exception:
            return

    return app


app = create_public_app()
