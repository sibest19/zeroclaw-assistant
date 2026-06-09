# Manutenzione & aggiornamenti

Come tenere l'installazione allineata all'evoluzione di ZeroClaw, con il minimo
sforzo e senza sorprese.

## Principio: upstream intatto, noi attorno

ZeroClaw è un **git submodule** in `vendor/zeroclaw`, **pinnato** a un commit testato.
Non modifichiamo NESSUN file dell'upstream:
- il binario lo costruisce il **nostro** `Dockerfile.zeroclaw` (build da sorgente del
  submodule, solo `--bin zeroclaw`);
- tutto il resto è additivo in `deploy/`.

Conseguenza: **nessun fork, nessun rebase, nessun conflitto**. Aggiornare ZeroClaw =
spostare il puntatore del submodule e ricostruire.

## Perché costruiamo dal sorgente (per ora)

Il nostro config è **schema V3** (`[providers.models.*]`, `[risk_profiles.*]`, MCP…).
L'ultima release stabile pubblicata (`v0.7.5`) usa ancora **schema V2**, incompatibile.
Finché non esce una **release V3 ufficiale**, costruiamo dal commit master pinnato.

> Quando arriverà una release V3 con immagine prebuilt: sostituisci il blocco
> `build:` del servizio `zeroclaw` con `image: ghcr.io/zeroclaw-labs/zeroclaw:<tag>`
> ed elimina submodule + `Dockerfile.zeroclaw`. Fine del "build da sorgente".

## Procedura di aggiornamento

```bash
# 1. porta il submodule al nuovo commit/tag testato
git -C vendor/zeroclaw fetch origin
git -C vendor/zeroclaw checkout <commit-o-tag>

# 2. ricostruisci e prova IN LOCALE prima del server
cd deploy
docker compose build zeroclaw
docker compose up -d
docker compose exec zeroclaw zeroclaw doctor      # validazione + diagnosi
docker compose logs -f zeroclaw                   # cerca errori di migrazione/config

# 3. se ok, registra il pin
git add vendor/zeroclaw && git commit -m "bump zeroclaw a <ref>"
```

Lo schema config si **auto-migra** in avanti al caricamento; `doctor` segnala in modo
esplicito ogni incompatibilità. Rollback = `git -C vendor/zeroclaw checkout <vecchio>` +
rebuild. Tieni un backup di `comms/data/` e `zc-data/` prima di salti grandi.

## Note sul nostro build (`Dockerfile.zeroclaw`)

- `--bin zeroclaw`: NON compila gli app GUI/aux (`tauri`, `zerocode`) né gli esempi →
  niente stub, niente patch all'upstream (che invece il Dockerfile upstream richiederebbe
  su master HEAD).
- `CARGO_PROFILE_RELEASE_LTO=off`: il profilo release upstream usa `lto="fat"` che
  richiede ~12-16GB e va in OOM. Disattivato per il container (binario poco più grande).
- **Requisito RAM Docker:** dai alla VM **≥12-16GB** (con 8GB la build crasha).
- Cache mount cargo → i rebuild dopo un bump del submodule sono veloci.

## Segnali da tenere d'occhio

- **GitHub Releases** dell'upstream (specie l'arrivo di una **release V3**: cambia tutto in meglio).
- Breaking change di config/canali nelle note di rilascio.

## L'unico altro punto custom: il calendario

Se attiverai il calendario via CLI `gws`, vivrà nel `Dockerfile` del servizio comms o in un
MCP dedicato — sempre fuori dall'upstream. Da fare quando ci arriviamo.

## Cosa NON committare

Vedi `deploy/.gitignore`: `.env`, `**/auth-profiles.json` (token Codex), `**/*.db`
(archivio/sessioni), `**/wa-auth`, `zc-data/`, `comms/data/`, `node_modules`.
