# ngspice in a small container, so a host needs nothing but Docker to run
# Flamingo's SPICE checks. Built on demand by packages/server/src/spice-runner.ts.
FROM debian:trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ngspice \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /work
ENTRYPOINT ["ngspice"]
