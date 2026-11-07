# Local Solana validator with both programs preloaded at genesis:
#   - prediction_market (built from programs/ in this image)
#   - OpenBook v2 (dumped from devnet at build time)
# Agave only ships x86_64 Linux binaries, so this image is linux/amd64 (runs under Rosetta on Apple Silicon).
# Two Agave versions:
#   BUILD_AGAVE_VERSION     cargo build-sbf toolchain (Anchor 1.1 needs platform-tools with rustc >= 1.89)
#   VALIDATOR_AGAVE_VERSION the test validator. Agave >= 3.1.10 hard-requires io_uring, which Rosetta
#                           doesn't emulate, so the validator stays on 3.0.x. It runs the same SBPF v0 programs.
ARG BUILD_AGAVE_VERSION=v4.1.1
ARG VALIDATOR_AGAVE_VERSION=v3.0.14

FROM --platform=linux/amd64 rust:1.89-bookworm AS solana
ARG BUILD_AGAVE_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends bzip2 curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN curl -sSfL "https://github.com/anza-xyz/agave/releases/download/${BUILD_AGAVE_VERSION}/solana-release-x86_64-unknown-linux-gnu.tar.bz2" \
    | tar -xj -C /opt
ENV PATH=/opt/solana-release/bin:$PATH

FROM --platform=linux/amd64 debian:bookworm-slim AS validator-bin
ARG VALIDATOR_AGAVE_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends bzip2 curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN curl -sSfL "https://github.com/anza-xyz/agave/releases/download/${VALIDATOR_AGAVE_VERSION}/solana-release-x86_64-unknown-linux-gnu.tar.bz2" \
    | tar -xj -C /opt

FROM solana AS programs
WORKDIR /src
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY programs ./programs
RUN cargo build-sbf --manifest-path programs/prediction-market/Cargo.toml --sbf-out-dir /out
RUN solana program dump -u devnet opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb /out/openbook_v2.so

FROM --platform=linux/amd64 debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 libudev1 bzip2 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=validator-bin /opt/solana-release/bin/solana-test-validator /opt/solana-release/bin/solana /usr/local/bin/
COPY --from=programs /out/prediction_market.so /out/openbook_v2.so /programs/
COPY docker/validator-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 8899 8900
ENTRYPOINT ["/entrypoint.sh"]
