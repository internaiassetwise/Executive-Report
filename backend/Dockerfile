# Backend image: the Node API plus the Python workers it spawns (Excel reading,
# analysis, PDF export) and Noto Sans Thai, which exports.py finds for PDFs. Build from the repository root:
#   docker build -f backend/Dockerfile .
FROM node:22-bookworm-slim AS node

FROM python:3.12-slim-bookworm
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && apt-get update \
 && apt-get install -y --no-install-recommends fonts-noto-core \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

# Workspace manifests only, so npm ci is cached until dependencies change.
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci --workspace=@asw/backend --omit=dev --ignore-scripts

COPY shared shared
COPY backend backend

ENV NODE_ENV=production \
    PYTHON_BIN=python \
    PYTHONDONTWRITEBYTECODE=1
CMD ["npm", "run", "start:backend"]
