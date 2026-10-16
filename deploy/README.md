# Homebox + Companion + Gemini stack

Docker Compose stack for running Homebox and this Companion fork together, with Gemini as the LLM and Tailscale Serve for HTTPS access from an iPhone.

## 1. Prerequisites (Windows, WSL2, Docker Desktop)

1. Install Docker Desktop and enable the WSL2 backend.
2. In Docker Desktop, open Settings, Resources, WSL integration, and enable your Ubuntu distro. Verify inside WSL: `docker compose version`.
3. Clone this repo inside WSL (for example `~/projects/homebox-companion`), not on `/mnt/c`.
4. Get a Google AI Studio API key from https://aistudio.google.com/apikey.

## 2. First run

```bash
cd ~/projects/homebox-companion/deploy
cp .env.example .env
openssl rand -base64 48        # paste into HBOX_AUTH_API_KEY_PEPPER
# edit .env: HBC_LLM_API_KEY, HBC_LINK_BASE_URL (see section 4)
docker compose up -d --build
```

- Homebox: http://localhost:7745
- Companion: http://localhost:8000

Companion stays unusable until `HBC_HOMEBOX_API_KEY` is set, so continue with the next section.

## 3. Homebox account and API key

1. Open http://localhost:7745 and register your account (registration is on by default for this step).
2. In `.env`, set `HBOX_OPTIONS_ALLOW_REGISTRATION=false`.
3. In Homebox, open Profile, then API keys, create a key, and copy the `hb_...` value.
4. Put it in `.env` as `HBC_HOMEBOX_API_KEY=hb_...`.
5. Apply both changes: `docker compose up -d`.

The pepper must stay the same for the life of the Homebox data volume. Changing it invalidates existing API keys.

Security caveat: with an API key configured, Companion has no login screen. Everyone who can reach port 8000 acts as that Homebox user. Keep the ports private to your machine and tailnet (do not forward them on your router, and do not use Tailscale Funnel).

## 4. HTTPS on iPhone with Tailscale Serve

iOS needs HTTPS for the camera in a home-screen web app.

1. In the Tailscale admin console, enable MagicDNS and HTTPS Certificates for the tailnet.
2. On the Windows host (Docker Desktop publishes the ports there), run:

   ```powershell
   tailscale serve --bg --https=443 http://localhost:8000
   tailscale serve --bg --https=8443 http://localhost:7745
   tailscale serve status
   ```

3. Set in `.env`: `HBC_LINK_BASE_URL=https://<host>.<tailnet>.ts.net:8443`, then `docker compose up -d`.
4. Install Tailscale on the iPhone and sign in to the same tailnet.

Companion is then at `https://<host>.<tailnet>.ts.net` and Homebox at `https://<host>.<tailnet>.ts.net:8443`.

## 5. QR labels that the iPhone camera can open

Homebox embeds the URL you were browsing in generated QR codes. Open Homebox through `https://<host>.<tailnet>.ts.net:8443` (not `localhost`) before generating label sheets, so scanning a label with the iPhone camera resolves to a URL the phone can reach.

## 6. Add Companion to the iPhone home screen

In Safari, open `https://<host>.<tailnet>.ts.net`, tap Share, then Add to Home Screen.

## 7. Fallback model

The primary model comes from `HBC_LLM_MODEL` (`gemini/gemini-4-argon`). To add a fallback, open Companion, then Settings, and configure a fallback profile with model `gemini/gemini-3.8-flash` and the same Google API key. It is used automatically if the primary request fails.

## Naming and grouping

`.env.example` sets `HBC_AI_NAME`, `HBC_AI_NAMING_EXAMPLES`, and `HBC_AI_QUANTITY` so identical items are grouped into one entry with a quantity (four loose AA batteries become "AA Battery", quantity 4) and names include distinguishing attributes ("Yellow Coiled 3.5mm Audio Aux Cord", not "Audio cable"). Values saved on the Companion Settings page take priority over these env values.

## Maintenance

```bash
docker compose logs -f companion   # logs
docker compose up -d --build       # rebuild Companion after pulling changes
docker compose down                # stop (volumes are kept)
```

Data lives in the named volumes `homebox-stack_homebox-data` and `homebox-stack_companion-data`. Back up the Homebox volume before upgrading the Homebox image tag.
