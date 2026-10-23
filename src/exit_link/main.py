from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from exit_link.api.health import router
from exit_link.api.dashboard import router as dashboard_router, ws_router
from exit_link.api.runtime import Backend
from exit_link.api.security import ApiSettings
from exit_link.api.history import router as history_router


def create_app(settings: ApiSettings | None = None) -> FastAPI:
    settings = settings or ApiSettings.from_env()

    @asynccontextmanager
    async def lifespan(app):
        await app.state.backend.start()
        try:
            yield
        finally:
            await app.state.backend.close()

    app = FastAPI(
        title="EXIT-LINK",
        version="0.5.0",
        description="Local dashboard API: synthetic disasters and actual loopback TCP observations",
        lifespan=lifespan,
    )
    app.state.backend = Backend(settings)
    app.add_middleware(CORSMiddleware, allow_origins=list(settings.origins),
                       allow_methods=["GET", "POST", "PUT", "DELETE"],
                       allow_headers=["Content-Type", "X-Exit-Link-Token"])

    @app.exception_handler(ValueError)
    async def invalid_domain_input(request: Request, exc: ValueError):
        return JSONResponse(status_code=422, content={"detail": {"code": "invalid_domain_input", "message": str(exc)}})

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request: Request, exc: RequestValidationError):
        message = "; ".join(".".join(map(str, error["loc"])) + ": " + error["msg"] for error in exc.errors()[:20])
        return JSONResponse(status_code=422, content={"detail": {"code": "invalid_request", "message": message}})

    app.include_router(router)
    app.include_router(dashboard_router)
    app.include_router(ws_router)
    app.include_router(history_router)
    return app


app = create_app()
