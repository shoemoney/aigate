FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# The official CLIs the prompt API spawns (off unless AIGATE_PROMPT_API=1), installed globally as root
# at PINNED versions; bump deliberately. Global install means nothing is written under /app or the
# image at runtime: every run uses a throwaway home under AIGATE_PROMPT_TMPDIR and the CLI auto-updaters
# are disabled (DISABLE_AUTOUPDATER=1 is also set per run), so a read-only root only needs /tmp as tmpfs.
RUN npm install -g --no-audit --no-fund @anthropic-ai/claude-code@2.1.325 @openai/codex@0.169.0 && npm cache clean --force
COPY src ./src
COPY public ./public
COPY scripts ./scripts
ENV HOST=0.0.0.0 PORT=20200 AIGATE_DB=/app/data/aigate.db AIGATE_PROMPT_TMPDIR=/tmp DISABLE_AUTOUPDATER=1
# run as the built-in non-root `node` user (uid 1000): an RCE/dep-compromise then
# can't rewrite the mounted vault as root. NOTE for deploy: the HOST bind-mount dir
# (prod: /mnt/tank/apps/aigate/data) must be writable by uid 1000 — run once:
#   sudo chown -R 1000:1000 /mnt/tank/apps/aigate/data
# or the daemon can't open the DB (and self-heal-loops). Revert this block to run as
# root if you'd rather not chown the mount.
RUN mkdir -p /app/data && chown -R node:node /app
USER node
VOLUME /app/data
EXPOSE 20200
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||20200)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","src/server.js"]
