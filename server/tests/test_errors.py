"""Errors that no route handles: the answer of the app, and the connection that carried it."""
from __future__ import annotations

import http.client
import socket
import threading
import time

import uvicorn


def _boom():
    raise RuntimeError("an error that no route handles")


def _app_with_an_error(make_app):
    app = make_app()
    app.add_api_route("/api/test-error", _boom, methods=["GET", "POST"])
    app.add_api_route("/test/error-page", _boom, methods=["GET"])
    return app


def test_an_unhandled_error_answers_json_500(make_app, make_client):
    client = make_client(_app_with_an_error(make_app))
    for method in ("GET", "POST"):
        response = client.request(method, "/api/test-error")
        assert response.status_code == 500, method
        assert response.json() == {"error": "internal", "message": "An error in the server. Please try again later.",
                                   "params": {}}, method
        assert response.headers["cache-control"] == "no-store" and response.headers["x-content-type-options"] == "nosniff"
    # A page shows the error as a page, like every other error of a page, with the key of its text for the language.
    page = client.get("/test/error-page")
    assert page.status_code == 500 and page.headers["content-type"].startswith("text/html")
    assert '<p data-i18n="error.internal">An error in the server. Please try again later.</p>' in page.text


def _exchange(conn: socket.socket, path: str) -> tuple[int, dict, bytes]:
    conn.sendall(f"GET {path} HTTP/1.1\r\nHost: it-skills.test\r\n\r\n".encode("ascii"))
    response = http.client.HTTPResponse(conn)
    response.begin()
    return response.status, {k.lower(): v for k, v in response.getheaders()}, response.read()


def test_after_an_unhandled_error_the_connection_serves_the_next_request(make_app):
    """Uvicorn closes the connection when an error leaves the app after its answer began. The last error handler of
    Starlette always sends its 500 and raises the error again, so the connection used to close after every unhandled
    error, without "Connection: close". The proxy keeps its connections to the app open, sent the next request into the
    closed one and answered 502. The app now answers the error itself, so the connection stays open."""
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen()
    server = uvicorn.Server(uvicorn.Config(_app_with_an_error(make_app), lifespan="off", log_level="critical",
                                           access_log=False))
    thread = threading.Thread(target=server.run, kwargs={"sockets": [listener]}, daemon=True)
    thread.start()
    try:
        deadline = time.monotonic() + 10
        while not server.started:
            assert time.monotonic() < deadline, "uvicorn did not start"
            time.sleep(0.05)
        with socket.create_connection(listener.getsockname(), timeout=10) as conn:
            status, headers, body = _exchange(conn, "/api/test-error")
            assert status == 500 and b'"error":"internal"' in body and headers.get("connection") != "close"
            status, _, body = _exchange(conn, "/api/health")
            assert status == 200 and body == b'{"status":"ok"}'
    finally:
        server.should_exit = True
        thread.join(10)
        listener.close()


def test_the_early_answers_carry_the_headers_of_every_answer(quick_user, make_client):
    """Finding B5 of the final review: the 403 csrf of the middleware and the 413 of the body limit skipped the code of
    the headers, so they had no Cache-Control: no-store, no Content-Security-Policy and no X-Frame-Options. The 308 and
    the 404 of a name under the wildcard that is no user site get the same headers too."""
    from app.pages import site_policy

    anna = quick_user()
    big = b'{"title": "' + b"x" * (70 * 1024) + b'"}'
    raw = {"Content-Type": "application/json"}
    answers = {
        "403 csrf": (make_client(headers={}).post("/api/maps", json={"title": "x"}), 403),
        "403 csrf of a page": (make_client(headers={}).post("/account", json={}), 403),
        "413 with Content-Length": (anna.post("/api/maps", content=big, headers=raw), 413),
        "413 without Content-Length": (anna.post("/api/maps", content=iter([big[:1000], big[1000:]]), headers=raw), 413),
        "404 of a reserved name": (make_client().get("/api/health", headers={"Host": "api.it-skills.test"}), 404),
        "404 page of a reserved name": (make_client().get("/", headers={"Host": "api.it-skills.test"}), 404),
        "308 of www": (make_client().get("/api/health", headers={"Host": "www.it-skills.test"}, follow_redirects=False), 308),
    }
    for name, (response, status) in answers.items():
        assert response.status_code == status, (name, response.status_code)
        assert response.headers["x-content-type-options"] == "nosniff", name
        assert response.headers["referrer-policy"] == "same-origin", name
        assert response.headers["content-security-policy"] == site_policy("'self'"), name
        assert response.headers["x-frame-options"] == "SAMEORIGIN", name
        if response.request.url.path.startswith("/api"):
            assert response.headers["cache-control"] == "no-store", name
    assert answers["403 csrf"][0].json()["error"] == "csrf"
    assert answers["413 with Content-Length"][0].json()["error"] == "body_too_large"
