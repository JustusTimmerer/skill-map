"""The logs of the app: no access log, because such a log keeps IP addresses and the tokens of share links. The lines
of the app itself reach the log of the container, for example the migrations at its start."""
from __future__ import annotations

import logging
import os
import re
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

import psycopg
import uvicorn
from conftest import BASE, FIXTURES, TEST_DATABASE
from psycopg import sql

from app.migrate import MIGRATIONS

SHARE_TOKEN = "share-token-that-no-log-may-keep-0123456789"
# A line of the loggers of the app (main.log_to_stderr): "<LEVEL> skill-map...: <message>".
OWN_LINE = re.compile(r"^[A-Z]+ skill-map[.:]")


class Records(logging.Handler):
    def __init__(self):
        super().__init__()
        self.records: list[logging.LogRecord] = []

    def emit(self, record):
        self.records.append(record)


def test_no_access_log_also_when_the_start_command_asks_for_one(make_app):
    """Uvicorn writes an access log unless its start command has --no-access-log. The app turns it off itself, so a
    start command without the flag keeps the tokens of share links and the IP addresses out of the log too. The test
    starts uvicorn as its command line does: the logging setup first, then the factory of the app."""
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen()
    server = uvicorn.Server(uvicorn.Config(make_app, factory=True, lifespan="off", log_level="info", access_log=True))
    records = Records()
    access_log = logging.getLogger("uvicorn.access")
    access_log.addHandler(records)
    thread = threading.Thread(target=server.run, kwargs={"sockets": [listener]}, daemon=True)
    thread.start()
    try:
        deadline = time.monotonic() + 10
        while not server.started:
            assert time.monotonic() < deadline, "uvicorn did not start"
            time.sleep(0.05)
        host, port = listener.getsockname()
        for path in (f"/s/{SHARE_TOKEN}", f"/api/shared/{SHARE_TOKEN}", "/api/health"):
            with socket.create_connection((host, port), timeout=10) as conn:
                conn.sendall(f"GET {path} HTTP/1.1\r\nHost: it-skills.test\r\nConnection: close\r\n\r\n".encode("ascii"))
                answer = b""
                while chunk := conn.recv(65536):
                    answer += chunk
                assert answer.startswith(b"HTTP/1.1 "), path
    finally:
        server.should_exit = True
        thread.join(10)
        listener.close()
        access_log.removeHandler(records)
    assert [record.getMessage() for record in records.records] == []


def _start_as_the_image_does(database: str) -> list[str]:
    """Starts the app with the start command of the image (Dockerfile), on a free port of 127.0.0.1 and against the
    database, and stops it once its start is complete. Gives the lines that it wrote to stderr: the log of the
    container."""
    env = {**os.environ, "BASE_URL": BASE, "DATABASE_URL": f"dbname={database}", "SMTP_USER": "",
           "PAGE_FILE": str(FIXTURES / "page.html"), "START_FILE": str(FIXTURES / "start.html")}
    command = [sys.executable, "-m", "uvicorn", "--factory", "app.main:create_app", "--host", "127.0.0.1", "--port", "0",
               "--no-proxy-headers", "--no-server-header", "--no-access-log"]
    process = subprocess.Popen(command, cwd=Path(__file__).resolve().parent.parent, env=env, stdout=subprocess.DEVNULL,
                               stderr=subprocess.PIPE, text=True)
    lines: list[str] = []
    started = threading.Event()

    def read():
        for line in process.stderr:
            lines.append(line.rstrip("\n"))
            if "Application startup complete" in line or "Application startup failed" in line:
                started.set()
        started.set()

    reader = threading.Thread(target=read, daemon=True)
    reader.start()
    try:
        assert started.wait(60), "the app did not start within 60 s: " + " | ".join(lines)
    finally:
        process.terminate()
        process.wait(15)
        reader.join(5)
    return lines


def test_the_app_logs_its_migrations_to_the_log_of_the_container():
    """uvicorn sets up only its own loggers, so the lines of the app at the level INFO got lost. The app sends them to
    stderr itself (main.log_to_stderr). At its start it names each migration that it applies, and then the version of
    the database. At the next start it only names the version."""
    database = TEST_DATABASE + "_logs"
    with psycopg.connect("dbname=postgres", autocommit=True) as conn:
        conn.execute(sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(database)))
        conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(database)))
    try:
        files = sorted(path.stem for path in MIGRATIONS.glob("*.sql"))
        first = [line for line in _start_as_the_image_does(database) if OWN_LINE.match(line)]
        assert first == [f"INFO skill-map.migrate: applied the migration {name}" for name in files] + [
            f"INFO skill-map.migrate: the database is up to date: {files[-1]}"], first
        again = [line for line in _start_as_the_image_does(database) if OWN_LINE.match(line)]
        assert again == [f"INFO skill-map.migrate: the database is up to date: {files[-1]}"], again
    finally:
        with psycopg.connect("dbname=postgres", autocommit=True) as conn:
            conn.execute(sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(database)))
