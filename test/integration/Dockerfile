# Runs the integration test in a clean container — a fresh OS, a fresh HOME, none of the host's
# state — so "it works on my machine" cannot hide a missing dependency or a home-dir assumption.
#
#   docker build -f test/integration/Dockerfile -t spectra-integration .
#   docker run --rm spectra-integration
#
# The build context is the repo root. This installs the workspaces (which provides the `spectra`
# bin and tsx it runs on), copies the source, and runs test/integration/run.sh as a non-root user.
# It does NOT boot the stack — run.sh uses --dry-run everywhere a real run would reach docker — so
# this needs no docker-in-docker and is safe in plain CI. The full-stack e2e (build images, curl
# the UI) is a separate, heavier tier.

FROM node:22-slim

# The workspaces' package.json files, so `npm ci` sees the whole lockfile tree.
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/cli/package.json packages/cli/
RUN npm ci

# The source, over the top of the installed deps.
COPY . .

# A non-root user with its own home — the realistic shape of an install, and what proves the CLI
# does not depend on running as root or on the repo being the home directory.
RUN useradd --create-home tester
USER tester

CMD ["bash", "test/integration/run.sh"]
