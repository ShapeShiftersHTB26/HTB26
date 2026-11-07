FROM rust:1.89-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev libudev-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
# backend depends on the program crate by path (../programs/prediction-market)
COPY Cargo.toml ./Cargo.toml
COPY programs ./programs
COPY backend ./backend
WORKDIR /src/backend
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 libudev1 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/backend/target/release/pm-backend /usr/local/bin/pm-backend
WORKDIR /app
EXPOSE 8080
CMD ["pm-backend"]
