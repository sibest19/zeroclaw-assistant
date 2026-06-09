# zeroclaw-assistant

Assistente personale privato di Simone, costruito **sopra** ZeroClaw senza
modificarne il sorgente. ZeroClaw è incluso come **submodule pinnato**; tutto il
nostro lavoro vive qui attorno.

## Struttura

```
zeroclaw-assistant/
├── Dockerfile.zeroclaw     # build del binario ZeroClaw dal submodule (nostro, niente patch upstream)
├── vendor/zeroclaw/        # SUBMODULE upstream, pinnato a un commit testato
└── deploy/
    ├── docker-compose.yml  # stack: zeroclaw (agente) + comms (archivio+MCP)
    ├── config.toml         # config V3 del container ZeroClaw
    ├── IDENTITY.md         # persona dell'agente (→ copiata in zc-data da setup-zc-data.sh)
    ├── sops/               # riassunti schedulati (hourly-digest, daily-brief)
    ├── comms/           # servizio Node: WhatsApp + embeddings + MCP server
    ├── setup-zc-data.sh    # assembla il volume di ZeroClaw (config+persona+auth)
    └── MAINTENANCE.md      # aggiornamenti, requisiti, note
```

Lo stato (DB archivio, sessioni WhatsApp, auth Codex, `node_modules`, volumi) è
**gitignored** — vedi `deploy/.gitignore`.

## Architettura

```
[comms]  WhatsApp Web (Baileys) + IMAP → archive.db (SQLite, FTS + embeddings locali)
            └── MCP server (HTTP :8765)
                        ▲ http://comms:8765/mcp
[zeroclaw]  Telegram (controllo) + Codex (gpt-5.5) + client MCP → legge/cerca l'archivio
            invii (WhatsApp/email) dietro conferma
```

## Avvio

```bash
git clone --recurse-submodules <questo-repo>
cd deploy
cp .env.example .env          # metti il bot token Telegram
./setup-zc-data.sh            # config + persona + auth Codex
docker compose up -d
docker compose logs -f comms   # QR WhatsApp (solo primo pairing)
```

## Aggiornare ZeroClaw upstream

```bash
git -C vendor/zeroclaw fetch origin
git -C vendor/zeroclaw checkout <nuovo-commit-o-tag>
# testa: docker compose build zeroclaw && docker compose up -d && verifica
git add vendor/zeroclaw && git commit -m "bump zeroclaw to <ref>"
```

Nessun rebase, nessun conflitto: l'upstream resta intatto nel submodule.
Quando esce una **release V3 ufficiale** con immagine prebuilt, si può sostituire
il build con `image: ghcr.io/zeroclaw-labs/zeroclaw:<tag>` ed eliminare il submodule.
