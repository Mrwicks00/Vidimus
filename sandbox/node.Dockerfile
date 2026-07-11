# Vidimus M3.C sandbox image. docs/VERIFICATION_MODULES.md M3.C.
#
# Network is used here, at IMAGE BUILD time only (by us, ahead of any job) - the per-job
# container this image runs in is always started with --network none (src/security/sandbox.ts).
# tsx and typescript are baked in so no per-job `npm install` is ever needed or possible.
FROM node:20-slim

RUN npm install -g tsx && npm cache clean --force

# Our own trusted runner scripts, kept outside /workspace (the untrusted delivered-code mount)
# so they can never be shadowed or overwritten by delivered content.
COPY runner /opt/vidimus
RUN cd /opt/vidimus && npm install --omit=dev && npm cache clean --force

WORKDIR /workspace
