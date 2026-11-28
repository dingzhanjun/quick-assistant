FROM python:3.12-slim@sha256:191083cdf6c7bda8c76158983163ead5d5cf7b77cf3033e805bb0f5296f51b4b

COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy PYTHONUNBUFFERED=1

WORKDIR /app

# Dependencies first so this layer is cached until pyproject/uv.lock change.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project --no-dev

COPY src ./src
RUN uv sync --frozen --no-dev

# Pre-download model files (Silero VAD etc.) so calls don't wait on a download at startup.
RUN uv run python -m order_agent.main download-files

RUN useradd --create-home agent && chown -R agent /app
USER agent

# Config comes from environment variables (see DEPLOY.md); no .env file in the image.
CMD ["uv", "run", "python", "-m", "order_agent.main", "start"]
