# Deploying Backtrace on a Vultr VPS

This guide takes the whole app (Research, Graph, Predictions) from your laptop to one Vultr server, served over HTTPS at your own domain. Plan on about an hour, most of it spent waiting on the first build and on devnet SOL.

## What you end up with

```
browser ──HTTPS──▶ Caddy (web, ports 80/443) ─┬─ /          static React build
                                               ├─ /api/*     api:8000 ──▶ Memgraph, hosted Postgres (PG_DSN), Anthropic
                                               └─ /pm-api/*  prediction-market-backend:8080 ──▶ hosted Postgres, Solana devnet
browser ──▶ Solana devnet RPC directly (wallet transactions)
```

| Piece | Runs on | Reachable from the internet? |
|---|---|---|
| `web`: Caddy serving the built frontend; it gets its own HTTPS certificate | VPS | yes, 80 and 443 only |
| `api`: research threads, ops, the agent chat | VPS | no (only through Caddy at `/api`) |
| `memgraph`: graph store for views, proposals and threads | VPS | no (localhost only; reach it over an SSH tunnel) |
| `prediction-market-backend`: markets, bots, faucet | VPS | no (only through Caddy at `/pm-api`) |
| Postgres: the data plane (`PG_DSN`) plus the market database | your hosted provider | your provider's settings |
| Solana devnet | public network | yes |

Three compose files stack on top of each other:
- `docker-compose.yml`: the dev stack.
- `docker-compose.prod.yml`: swaps the local market Postgres and the local validator for hosted Postgres and devnet.
- `docker-compose.vps.yml`: production web (Caddy), no `--reload`, no open ports, restart on reboot.

On the server, `COMPOSE_FILE` in `.env` makes a plain `docker compose` use all three.

## Before you start

- [ ] **The deploy files are pushed.** The server builds what's on GitHub: `docker-compose.vps.yml`, `deploy/Caddyfile`, `web/Dockerfile.prod`, this guide, and your latest work.
- [ ] **A domain**, where you can add an A record, e.g. `backtrace.example.com`. If you have no domain, use `<server-ip-with-dashes>.sslip.io` (see step 3).
- [ ] **Hosted Postgres** with two databases: one for the data plane (`PG_DSN`, which your local `.env` probably already has) and one for the markets (e.g. `pm`). They can live on the same server. Vultr Managed Databases for PostgreSQL works if you don't have a provider yet.
- [ ] **An Anthropic API key.** Set a monthly spend limit in the Anthropic Console: anyone who can open the site can drive the agent.
- [ ] **For the one-time devnet setup, on your laptop:** Solana CLI and Anchor (the same toolchain that builds `prediction-market/`).
- [ ] **A devnet RPC URL.** A free Helius or Triton devnet endpoint copes with the bots better than `https://api.devnet.solana.com`.

---

## 1. One-time devnet setup (laptop)

Skip this step if a teammate already did it. In that case, get `prediction-market/keys/` and `prediction-market/target/deploy/prediction_market-keypair.json` from them.

```bash
cd prediction-market
solana-keygen pubkey keys/admin.json      # the admin wallet (setup.sh creates keys/admin.json if it's missing)
```

Fund that address with about **15 devnet SOL**:
- use https://faucet.solana.com (signing in with GitHub raises the limit);
- or repeat `solana airdrop 2 <ADMIN> -u devnet`, which is rate-limited.

Where the SOL goes:
- about 2 SOL to deploy the program;
- **about 4 SOL of rent for every market**, including markets anyone creates from the UI;
- the rest funds the bots and the faucet.

Then deploy the program and create the mUSDC mint:

```bash
RPC_URL=https://api.devnet.solana.com ./scripts/setup.sh
solana-keygen pubkey target/deploy/prediction_market-keypair.json
```

- **Program id:** the printed id must equal `declare_id!` in `programs/prediction-market/src/lib.rs` (currently `5XrnC3eMafJx5ckPKk6Mw5nvX1TJAQ2VaU9xEXR4nLyE`). If it differs, add `PROGRAM_ID=<printed id>` to `prediction-market/.env.prod` in step 5.
- **If only the script's last step (`init-config`) fails, carry on.** The backend creates the mint and the on-chain Config at its first start when they're missing (`BOOTSTRAP_ON_START`).

## 2. Create the server (Vultr console)

1. **Upload your SSH key** under Account → SSH Keys. Your key is the output of `cat ~/.ssh/id_ed25519.pub`; if you don't have one, create it with `ssh-keygen -t ed25519`.
2. **Deploy +** → Deploy New Server:
   - **Type:** Cloud Compute, Shared CPU (High Performance or Regular Performance).
   - **Location:** close to your users or judges.
   - **Image:** Ubuntu 24.04 LTS x64.
   - **Plan:** **4 vCPU / 8 GB RAM recommended**, 2 vCPU / 4 GB minimum (step 4 adds swap). Take a disk of 50 GB or more. Memory goes to three things:
     - the Rust release build of the market backend, which peaks around 2–3 GB;
     - Memgraph, which keeps the graph in RAM;
     - every agent chat, each of which starts its own Claude Code process.
   - **SSH Keys:** select yours.
   - **Auto Backups:** worth enabling for a demo you care about (paid add-on).
   - Server hostname/label: `backtrace`.
3. Deploy, then note the **IPv4 address** (used below as `203.0.113.10`).

## 3. DNS and firewall

**DNS.** At your DNS provider, add an **A record** `backtrace.example.com → 203.0.113.10`. Two cautions:
- **Skip the AAAA record** unless you also open IPv6 in the firewall: a stale AAAA record breaks certificate issuance.
- **On Cloudflare, use "DNS only"** (grey cloud), at least until the certificate is issued.

To test without a domain, use `203-0-113-10.sslip.io`: it resolves to that IP on its own, and Caddy can get a certificate for it.

```bash
dig +short backtrace.example.com      # must print 203.0.113.10 before you start the stack
```

**Vultr Firewall.** Go to Network → Firewall → Add Firewall Group (e.g. `backtrace`).
- Inbound IPv4 rules:
  - SSH, port 22, from your IP (or anywhere);
  - HTTP, port 80, from anywhere;
  - HTTPS, port 443, from anywhere.
- Under **Linked Instances**, attach the server.

Vultr filters traffic before it reaches the server. That matters because ports published by Docker skip `ufw`. `docker-compose.vps.yml` publishes only 80 and 443, but the cloud firewall is the backstop.

## 4. Prepare the server

```bash
ssh root@203.0.113.10
```

**Updates and a deploy user**

```bash
apt-get update && apt-get -y upgrade
adduser deploy                        # pick a password; sudo asks for it
usermod -aG sudo deploy
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy
```

Check that `ssh deploy@203.0.113.10` works from your laptop, in a second terminal, before going on.

**SSH hardening (optional).** Run this as `deploy`. The file name starts with `00-` because sshd keeps the *first* value it reads, and Vultr's `50-cloud-init.conf` turns password login on.

```bash
sudo tee /etc/ssh/sshd_config.d/00-hardening.conf >/dev/null <<'EOF'
PasswordAuthentication no
PermitRootLogin no
EOF
sudo systemctl restart ssh
```

**Host firewall**

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw --force enable
```

**Swap.** This keeps the first build from running out of memory, especially on a 4 GB plan.

```bash
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

**Docker Engine and the Compose plugin**, from Docker's apt repository. Ubuntu's own packages are too old for the `!reset` / `!override` tags the compose files use.

```bash
sudo apt-get install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker deploy
exit                                   # log back in so the docker group applies
```

```bash
ssh deploy@203.0.113.10
docker compose version                 # needs v2.24.4 or newer
```

## 5. Code, secrets and data

**Clone the repo** as `deploy`. If the repo is public:

```bash
git clone https://github.com/ShapeShiftersHTB26/HTB26.git ~/HTB26
```

If it's private, use a read-only deploy key:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/github_deploy -N "" -C backtrace-vps
cat ~/.ssh/github_deploy.pub          # GitHub → repo → Settings → Deploy keys → Add deploy key (leave write access off)
cat >> ~/.ssh/config <<'EOF'
Host github.com
  IdentityFile ~/.ssh/github_deploy
  IdentitiesOnly yes
EOF
git clone git@github.com:ShapeShiftersHTB26/HTB26.git ~/HTB26
```

**Copy what git doesn't carry.** Run this from the repo root on your **laptop**.

```bash
SERVER=deploy@203.0.113.10
rsync -av prediction-market/keys/ $SERVER:HTB26/prediction-market/keys/   # admin + mUSDC mint keypairs
rsync -av --progress data/raw/ $SERVER:HTB26/data/raw/                    # catalog CSVs (~250 MB); only needed to load datasets on the server
scp .env $SERVER:HTB26/.env                                               # starting point: keeps ANTHROPIC_API_KEY and PG_DSN
```

Rows you already loaded into Postgres stay there, and the server reads them through the same `PG_DSN`. If you want your existing research on the server too, see "Optional: bring your local research over" below; it also explains why dev and prod shouldn't keep sharing that database afterwards.

**Root `.env`.** On the server, edit `~/HTB26/.env` so it contains:

```dotenv
# --- VPS
DOMAIN=backtrace.example.com
COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml:docker-compose.vps.yml

# --- app
ANTHROPIC_API_KEY=sk-ant-...
PG_DSN=postgresql://USER:PASSWORD@HOST:5432/backtrace?sslmode=require
BACKTRACE_STORE=postgres
PM_ADMIN_KEY=<the same value as ADMIN_API_KEY in prediction-market/.env.prod>
```

**`prediction-market/.env.prod`**

```bash
cd ~/HTB26
cp prediction-market/.env.prod.example prediction-market/.env.prod
openssl rand -hex 16                  # use this as ADMIN_API_KEY here and as PM_ADMIN_KEY in .env
nano prediction-market/.env.prod
```

- `DATABASE_URL`:
  - the **market** database, e.g. `.../pm?sslmode=require`;
  - use a direct or session-mode connection, never a transaction pooler (Supabase's port 6543 breaks prepared statements).
- `RPC_URL`: your devnet RPC.
  - If the URL contains an API key, also set `PUBLIC_RPC_URL=https://api.devnet.solana.com`, because browsers receive `PUBLIC_RPC_URL`.
- `ADMIN_API_KEY`: the value you just generated.
- Leave `DEMO_MARKETS` off: each demo market costs about 4 SOL.

**Lock the files down**

```bash
chmod 600 .env prediction-market/.env.prod prediction-market/keys/*.json
```

## 6. Start it

```bash
cd ~/HTB26
docker compose config --services      # expect: api, memgraph, prediction-market-backend, web
docker compose up -d --build          # first build: roughly 10–20 min, mostly the Rust backend
docker compose ps                     # all four running
docker compose logs -f web            # wait for "certificate obtained successfully", then Ctrl-C
```

## 7. Check it works

```bash
curl -I https://backtrace.example.com                                   # HTTP/2 200
curl https://backtrace.example.com/pm-api/health                        # ok
curl -s -X POST https://backtrace.example.com/api/op/get_graph \
  -H 'content-type: application/json' -d '{}' | head -c 200             # JSON with views
docker compose logs --tail 50 prediction-market-backend                 # bootstrap done, bots started
```

In the browser:
- **Research:** ask a question; the agent replies, which proves the Anthropic key works.
- **Predictions:** markets load.
  - Switch your wallet to devnet; in Phantom, turn on testnet mode under developer settings and pick Solana Devnet.
  - Connect, claim mUSDC from the faucet, then place a small trade.

## 8. Running it day to day

| Task | Command (in `~/HTB26`) |
|---|---|
| Deploy new code | `git pull && docker compose up -d --build` (only the changed images rebuild) |
| Reclaim disk after rebuilds | `docker image prune -f` |
| Follow logs | `docker compose logs -f --tail 100 api` (or `web`, `prediction-market-backend`, `memgraph`) |
| Restart one service | `docker compose restart api` |
| Edit the Caddyfile | edit `deploy/Caddyfile`, then `docker compose restart web` |
| Stop everything | `docker compose down`. **Never `down -v`**: it deletes Memgraph's data and the certificates |
| Server reboot | nothing to do: every service has `restart: unless-stopped` and Docker starts at boot |
| Admin wallet balance | `solana balance <ADMIN> -u devnet` on your laptop, or `curl https://backtrace.example.com/pm-api/bots/status` |

**Memgraph Lab (graph browser), when you need it:**

```bash
docker compose --profile tools up -d lab              # on the server
ssh -N -L 3000:localhost:3000 deploy@203.0.113.10     # on the laptop, then open http://localhost:3000
docker compose stop lab                               # when done
```

**Backups:**
- **Memgraph** holds views, proposals, research threads and fingerprints. The state export is small and doesn't depend on the Memgraph version, so it doubles as a backup:
  ```bash
  python3 scripts/export_state.py                 # data/state/<stamp>/ on the server (gitignored)
  rsync -av deploy@203.0.113.10:HTB26/data/state/ ./state-backups/     # pull it off the server, from your laptop
  ```
  To restore, run `python3 scripts/import_state.py <stamp> --replace`. The rows themselves live in Postgres.
- **Postgres:** your provider's backups.
- **`prediction-market/keys/`:** keep an offline copy. `admin.json` is the wallet that pays for everything.
- **The whole server:** Vultr Auto Backups or snapshots.

## Optional: bring your local research over

Your laptop's threads, views and fingerprints live in its Memgraph graph. The row data is already in Postgres. `scripts/export_state.py` and `scripts/import_state.py` move the graph plus the agentic-step cache; the dev-run skill has the details.

**On the laptop** (from the repo root, with your local stack running):

```bash
python3 scripts/export_state.py                                   # writes data/state/<stamp>/ (~300 KB): graph dump, agentic cache, manifest
rsync -av data/state/ deploy@203.0.113.10:HTB26/data/state/
```

**On the server** (from `~/HTB26`, with the stack running):

```bash
python3 scripts/import_state.py <stamp>       # refuses a non-empty graph; --replace wipes the server's graph first (never Postgres)
python3 scripts/import_state.py --check       # every manifest finds its rows; spot-verifies a few results
```

- **Same Postgres, then hand it over.** The import only finds rows if the server's `PG_DSN` points at the same Postgres as the export. After the move, stop using that database from your laptop: point your local `.env` at another one. Otherwise the two graphs drift apart, and a full reset on either side deletes rows the other still uses.
- **Old market links:** markets you created locally lived on the local chain, so "open market #N" links in old threads point at markets that don't exist on devnet.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `!reset` / `!override` errors, or "unknown tag" | Compose is too old. Install it from Docker's apt repository (step 4) |
| `set DOMAIN in .env` / `set PM_ADMIN_KEY in .env` | Fill both in `~/HTB26/.env` |
| `env file .../prediction-market/.env.prod not found` | Create it (step 5) |
| Build dies with `exit code 137` / `Killed` | Out of memory. Add swap (step 4) or resize the plan in Vultr, then rerun `docker compose up -d --build` |
| Browser shows a certificate error; `docker compose logs web` shows ACME errors | DNS doesn't point at the server yet (`dig +short`), or ports 80/443 are closed in the Vultr Firewall. Fix it, then `docker compose restart web`. Don't loop restarts: Let's Encrypt rate-limits failed attempts |
| `502` on `/api/...` | The api crashed; run `docker compose logs api`. Usual causes: a missing or wrong `PG_DSN`, or Memgraph still starting |
| The agent chat errors out | A wrong `ANTHROPIC_API_KEY`, or the account is out of credit |
| Datasets show "not downloaded" | `data/raw/` wasn't copied to the server (step 5) |
| The Predictions tab is empty and the backend restarts in a loop | Run `docker compose logs prediction-market-backend`. Usual causes:<br>• `DATABASE_URL` points at a transaction pooler<br>• the admin wallet is out of devnet SOL<br>• the devnet RPC is rate-limiting (HTTP 429): switch to a Helius or Triton URL<br>• `PROGRAM_ID` doesn't match the deployed program (step 1) |
| Wallet transactions fail in the browser | The wallet is on mainnet; switch it to devnet |

## Security notes

- **The app has no login.** Anyone with the URL can:
  - use the agent, which bills your Anthropic account;
  - call the REST ops at `/api/op/*`, including writes;
  - create markets, whose rent the admin wallet pays.

  For a private demo, set `ACCESS_CODE` in `.env`: every visitor first gets an "enter access code" page, which covers the app, `/api` and `/pm-api`. Caddy asks the api about each request (`forward_auth`, `api/app/gate.py`), and the right code sets a cookie that lasts 30 days. The browser password block in `deploy/Caddyfile` is an alternative.
- **Keep 7687 private.** Memgraph has no password. `docker-compose.vps.yml` binds it to localhost only; keep it that way.
- **Never commit the secrets.** `.env`, `prediction-market/.env.prod` and `prediction-market/keys/` are gitignored.
- **Security updates.** Ubuntu installs them automatically (`unattended-upgrades`). After a kernel update, reboot when convenient: `sudo reboot`.
