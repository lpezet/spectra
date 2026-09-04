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

# Source first, THEN install. The `spectra` bin is a source file (the repo has no build step), so
# npm must see it to create the node_modules/.bin/spectra link — installing before the copy would
# link a target that does not exist yet. (This costs layer caching, which a test image does not need.)
WORKDIR /src
COPY . .
RUN npm ci

# A non-root user with its own home — the realistic shape of an install, and what proves the CLI
# does not depend on running as root or on the repo being the home directory.
RUN useradd --create-home tester
USER tester

CMD ["bash", "test/integration/run.sh"]
