#
# Local deployment image for the CodeSprite Web UI + full SaaS FastAPI API.
# - Builds frontend (Vite) inside the image (no Node/npm required on host).
# - Runs backend with Python 3.11 (host CentOS7 system python is too old).
#

FROM node:20-alpine AS frontend_builder
WORKDIR /app/frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY frontend/ ./

# Cache bust for frontend build only (keeps npm ci cached).
ARG FRONTEND_BUILD_BUST=0
ENV FRONTEND_BUILD_BUST=${FRONTEND_BUILD_BUST}
RUN echo "FRONTEND_BUILD_BUST=${FRONTEND_BUILD_BUST}" > /tmp/frontend_build_bust

# Feature flags for Vite build (optional)
# - VITE_DASHBOARD_ENABLED=0 hides the "控制台" tab and defaults /app to "资产管理"
# Default to 0 to prevent accidental builds from re-enabling dashboard.
ARG VITE_DASHBOARD_ENABLED=0
ENV VITE_DASHBOARD_ENABLED=${VITE_DASHBOARD_ENABLED}

RUN npm run build


FROM python:3.11-slim AS runtime
WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8030 \
    SERVE_FRONTEND=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_DEFAULT_TIMEOUT=120 \
    PIP_RETRIES=10

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates tar gzip default-mysql-client \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL "https://aliyuncli.alicdn.com/aliyun-cli-linux-latest-amd64.tgz" -o /tmp/aliyun.tgz \
    && tar -xzf /tmp/aliyun.tgz -C /tmp \
    && install -m 0755 /tmp/aliyun /usr/local/bin/aliyun \
    && rm -f /tmp/aliyun.tgz /tmp/aliyun

COPY saas_api/requirements.txt saas_api/requirements.txt
RUN pip install --no-cache-dir --retries 10 --timeout 120 -r saas_api/requirements.txt

COPY saas_api/ saas_api/
COPY cicd/scripts/ cicd/scripts/
COPY --from=frontend_builder /app/frontend/dist frontend/dist

# Provide a default releases.json for /api/public/releases
COPY releases.example.json releases.json

EXPOSE 8030

CMD ["uvicorn", "app.server:app", "--app-dir", "saas_api", "--host", "0.0.0.0", "--port", "8030"]







