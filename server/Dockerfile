FROM python:3.12-slim

# No pip install is performed: the service uses only the Python standard
# library. The base image must already be available to the Docker daemon.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATABASE_PATH=/data/threadline.db \
    ATTACHMENTS_DIR=/data/attachments

RUN useradd --create-home --uid 10001 --user-group appuser \
    && mkdir -p /data \
    && chown appuser:appuser /data

WORKDIR /app
COPY --chown=appuser:appuser app.py /app/app.py

USER appuser
EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD ["python", "-c", "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:' + os.environ.get('PORT', '8787') + '/api/health', timeout=3).read()"]

ENTRYPOINT ["python", "app.py"]
