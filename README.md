# 𝐒𝐇𝟒𝐃𝟎𝐖 𝐁𝟒𝐒𝟏𝐓 Panel
Pterodactyl-style panel for Node.js bots/apps (Console, File Manager, Startup).

## Deploy on Render
1. Push this folder to GitHub → Render → New **Web Service**.
2. Build: `npm install --no-audit --no-fund` · Start: `npm start`
3. Env vars: `PANEL_PASSWORD` (required, your login), `MEMORY_LIMIT_MB` (default 512).
4. Optional: add a Persistent Disk mounted at `/data` and set `DATA_DIR=/data` so uploads survive redeploys.

Without a disk, Render's filesystem resets on each deploy (free plan also sleeps when idle).
