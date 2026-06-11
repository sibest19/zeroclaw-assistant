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

## CI/CD — immagini su GHCR (`.github/workflows/docker-publish.yml`)

Una GitHub Action costruisce e pubblica le tre immagini sul **GitHub Container
Registry** (`ghcr.io`), **multi-arch**, a ogni push su `main` (e su tag `v*.*.*`):

| Immagine | Arch | Note |
|---|---|---|
| `ghcr.io/<owner>/zeroclaw-comms` | amd64 + arm64 | cross-build pulito |
| `ghcr.io/<owner>/zeroclaw-agent` | amd64 + arm64 | Rust dal submodule pinnato |
| `ghcr.io/<owner>/zeroclaw-transcriber` | **solo amd64** | torch/NeMo non hanno wheel arm64 sull'indice CPU di PyTorch; il target è x86. Per provarci: rivedi l'install di torch e aggiungi `linux/arm64` alla matrix. |

Multi-arch via QEMU+Buildx su `ubuntu-latest` (funziona su qualsiasi piano/visibilità).
La prima build arm64 dell'agent (Rust emulato) è **lenta** ma cache-ata (GHA cache per
immagine). Se diventa un problema: passa a runner arm64 nativi (`ubuntu-24.04-arm`) con
build per-arch + merge dei digest.

**Nessun secret nel pipeline:** il push usa `GITHUB_TOKEN` effimero (niente PAT/secret
versionati). Serve solo `permissions: packages: write`. Le immagini sono private finché
non rendi pubblico il package su GitHub.

Per **consumare** le immagini sul server invece di buildare, sostituisci i blocchi
`build:` in `docker-compose.yml` con `image: ghcr.io/<owner>/zeroclaw-<svc>:<tag>` (login:
`echo $TOKEN | docker login ghcr.io -u <owner> --password-stdin`).

### Gate anti-segreti

Il job `secret-scan` esegue **gitleaks** sull'intera history a ogni run; se trova un
segreto, build e publish **non partono**. Localmente:
`docker run --rm -v "$PWD:/repo" -w /repo zricethezav/gitleaks:latest git -v`.
Config in `.gitleaks.toml` (ruleset default + allowlist dei soli file template).

## Segnali da tenere d'occhio

- **GitHub Releases** dell'upstream (specie l'arrivo di una **release V3**: cambia tutto in meglio).
- Breaking change di config/canali nelle note di rilascio.

## L'unico altro punto custom: il calendario

Se attiverai il calendario via CLI `gws`, vivrà nel `Dockerfile` del servizio comms o in un
MCP dedicato — sempre fuori dall'upstream. Da fare quando ci arriviamo.

## Cosa NON committare

Vedi `deploy/.gitignore` (e il `.gitignore` root, backstop repo-wide): `.env`,
`**/auth-profiles.json` (token Codex), `**/.secret_key`, `**/*.db` (archivio/sessioni),
`**/wa-auth`, `zc-data/`, `comms/data/`, `node_modules`. Il gate **gitleaks** in CI è
la rete di sicurezza: se per sbaglio uno di questi finisse tracciato, il push viene
bloccato. Le immagini Docker usano `COPY` selettivi + `.dockerignore`, quindi nessun
segreto entra nel build context anche in locale.
