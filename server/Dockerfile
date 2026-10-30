# The app image (target "app") and the test image (target "test", the app plus pytest and the tests).
FROM python:3.13.16-slim-trixie@sha256:70729b46c69b4f1e97c4822c1af3df53a1476cf5ddc6c087c0c10bc3a5678c2f AS app
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_ROOT_USER_ACTION=ignore
WORKDIR /srv/app
COPY requirements.txt .
RUN pip install --no-deps -r requirements.txt && pip check
RUN useradd --system --uid 10001 --no-create-home --home-dir /srv/app app
COPY app ./app
COPY migrations ./migrations
USER app
EXPOSE 8000
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=12 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=2)"]
# --no-proxy-headers: the app reads X-Forwarded-For itself, and only from TRUSTED_PROXIES.
# --no-access-log: an access log would keep IP addresses and the tokens of share links.
CMD ["uvicorn", "--factory", "app.main:create_app", "--host", "0.0.0.0", "--port", "8000", \
     "--no-proxy-headers", "--no-server-header", "--no-access-log"]

FROM app AS test
USER root
COPY requirements-dev.txt .
RUN pip install --no-deps -r requirements-dev.txt && pip check
COPY pytest.ini .
COPY tests ./tests
# Root, because the tests read the local root certificate of the proxy from its data volume.
CMD ["pytest"]
