# The box the spec tool runs in.
#
# Not a sandbox. @spec has no filesystem and no shell — six in-process tools are its whole
# reach — so this image adds no containment that mattered. It exists for one reason: an
# internal docker network cannot be reached from the host, so anything that wants to talk to
# the sandboxed @coder has to be *on* that network. This is express getting on it.
#
# The consequence is worth stating plainly, because it is the whole design: this container
# sits on two networks and @coder's sits on one. Express is the only way out, which is what
# makes proxying the model API through it possible rather than merely tidy.
#
# Unlike Dockerfile.coder, source is not baked in — packages/server and packages/core arrive
# as mounts so `tsx watch` reloads on save. Dependencies still come from the image, so a
# rebuild is only needed when package.json moves.

FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /stack

# Every workspace's package.json, because `npm ci` verifies the whole lockfile tree and
# fails on a workspace it cannot see — even one it then installs nothing for.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/

# --omit=dev drops vite, vitest and typescript, none of which run here. It keeps tsx, which
# is not a dev tool in this repo: the server has no build step and this is how it runs.
RUN npm ci --omit=dev

# packages/server and packages/core are mounted over at run time; these copies are what makes
# the image runnable on its own, and what a mount-less deployment would use.
COPY tsconfig.base.json ./
COPY packages/core/ packages/core/
COPY packages/server/ packages/server/

# uid 1000 either way, which is what lets it write ./data and ./specs on the host mount
# without a chown dance.
RUN chown -R node:node /stack
USER node

# Neither SPECS_DIR nor DATA_DIR defaults into the image any more — SPECS_DIR because the
# engine ships empty, DATA_DIR because runtime data now defaults to the XDG data home. Compose
# sets both (/stack/specs, /stack/data) to match the mounts.
ENV NODE_ENV=development
EXPOSE 5174
CMD ["node", "node_modules/.bin/tsx", "watch", "packages/server/src/main.ts"]
