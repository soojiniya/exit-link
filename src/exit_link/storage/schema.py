"""Version 1 migration. SQL is applied atomically, with an application ID/checksum."""
import hashlib

VERSION = 1
APPLICATION_ID = 0x45584C4B
DDL = """
CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);
CREATE TABLE backend_runs(
 run_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, ended_at TEXT, end_reason TEXT,
 environment_json TEXT NOT NULL CHECK(json_valid(environment_json)),
 recording_complete INTEGER NOT NULL DEFAULT 1 CHECK(recording_complete IN (0,1)));
CREATE TABLE experiments(
 archive_id INTEGER PRIMARY KEY AUTOINCREMENT, experiment_id TEXT NOT NULL UNIQUE,
 run_id TEXT NOT NULL REFERENCES backend_runs(run_id), created_at TEXT NOT NULL,
 started_at TEXT, ended_at TEXT, interruption_detected_at TEXT,
 status TEXT NOT NULL CHECK(status IN ('starting','running','stopping','stopped','failed','interrupted')),
 recording_complete INTEGER NOT NULL CHECK(recording_complete IN (0,1)),
 conditions_json TEXT NOT NULL CHECK(json_valid(conditions_json)),
 topology_json TEXT CHECK(topology_json IS NULL OR json_valid(topology_json)),
 last_control_json TEXT NOT NULL CHECK(json_valid(last_control_json)));
CREATE INDEX experiments_by_run ON experiments(run_id,archive_id);
CREATE TABLE scenario_revisions(
 scenario_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=1),
 building_id TEXT NOT NULL, hazards_json TEXT NOT NULL CHECK(json_valid(hazards_json)),
 PRIMARY KEY(scenario_id,revision));
CREATE TABLE event_log(
 archive_id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
 run_id TEXT NOT NULL REFERENCES backend_runs(run_id), experiment_id TEXT REFERENCES experiments(experiment_id),
 source_key TEXT NOT NULL UNIQUE, stream_id TEXT, sequence INTEGER, type TEXT NOT NULL,
 occurred_at TEXT NOT NULL, recorded_at TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 node_id TEXT, target_node TEXT, detection_ms REAL CHECK(detection_ms>=0),
 UNIQUE(run_id,stream_id,sequence));
CREATE INDEX events_by_experiment ON event_log(experiment_id,archive_id);
CREATE INDEX faults_by_target ON event_log(experiment_id,type,target_node);
CREATE TABLE scenario_snapshots(
 event_id TEXT PRIMARY KEY REFERENCES event_log(event_id), scenario_id TEXT NOT NULL, revision INTEGER NOT NULL,
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
 FOREIGN KEY(scenario_id,revision) REFERENCES scenario_revisions(scenario_id,revision));
CREATE TABLE guidance_messages(
 message_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES backend_runs(run_id),
 experiment_id TEXT REFERENCES experiments(experiment_id), scenario_id TEXT NOT NULL, revision INTEGER NOT NULL,
 route_version INTEGER NOT NULL CHECK(route_version>=1), issued_at TEXT NOT NULL,
 guidance_json TEXT NOT NULL CHECK(json_valid(guidance_json)),
 FOREIGN KEY(scenario_id,revision) REFERENCES scenario_revisions(scenario_id,revision));
CREATE INDEX messages_by_experiment ON guidance_messages(experiment_id,issued_at);
CREATE TABLE guidance_deliveries(
 archive_id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL UNIQUE REFERENCES guidance_messages(message_id),
 ack_received INTEGER NOT NULL CHECK(ack_received IN (0,1)), elapsed_ms REAL CHECK(elapsed_ms>=0),
 route_calculation_ms REAL CHECK(route_calculation_ms>=0), recovery_ms REAL CHECK(recovery_ms>=0),
 retries INTEGER CHECK(retries>=0), observed_at TEXT NOT NULL,
 delivery_json TEXT NOT NULL CHECK(json_valid(delivery_json)));
CREATE TABLE delivery_attempts(
 message_id TEXT NOT NULL REFERENCES guidance_deliveries(message_id), attempt_number INTEGER NOT NULL CHECK(attempt_number>=1),
 duration_ms REAL NOT NULL CHECK(duration_ms>=0), calculation_ms REAL NOT NULL CHECK(calculation_ms>=0),
 route_json TEXT NOT NULL CHECK(json_valid(route_json)), outcome TEXT NOT NULL,
 PRIMARY KEY(message_id,attempt_number));
CREATE TABLE control_actions(
 archive_id INTEGER PRIMARY KEY AUTOINCREMENT, action_id TEXT NOT NULL UNIQUE, run_id TEXT NOT NULL REFERENCES backend_runs(run_id),
 experiment_id TEXT NOT NULL REFERENCES experiments(experiment_id), action TEXT NOT NULL,
 node_id TEXT, requested_at TEXT NOT NULL, completed_at TEXT,
 state TEXT NOT NULL CHECK(state IN ('requested','succeeded','failed','interrupted')),
 details_json TEXT NOT NULL CHECK(json_valid(details_json)));
CREATE INDEX controls_by_experiment ON control_actions(experiment_id,requested_at);
"""
CHECKSUM = hashlib.sha256(DDL.encode()).hexdigest()
