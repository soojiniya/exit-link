from importlib.resources import files
from pathlib import Path

from exit_link.topology.models import Building, CommunicationTopology


def _read(name: str, path: Path | None) -> str:
    if path is not None:
        return path.read_text(encoding="utf-8")
    return files("exit_link").joinpath("data", "simulation", name).read_text(encoding="utf-8")


def load_building(path: Path | None = None) -> Building:
    return Building.model_validate_json(_read("building.json", path))


def load_communication(path: Path | None = None) -> CommunicationTopology:
    return CommunicationTopology.model_validate_json(_read("communication.json", path))


def validate_locations(building: Building, topology: CommunicationTopology) -> None:
    places = {node.id for node in building.nodes}
    for node in topology.nodes:
        if node.location_id not in places:
            raise ValueError(f"Unknown building location: {node.location_id}")
