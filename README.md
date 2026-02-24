# Chart Reader

Digitize scanned Billboard-style chart images into an append-only CSV using Gemini.

## Quick start (Docker)

1. Set the environment variable `GOOGLE_GENERATIVE_AI_API_KEY`.
2. Run:
   - `docker compose up --build`
3. Open `http://localhost:3000`

Files are stored in the mounted `./files` folder:
- `files/new` (incoming uploads)
- `files/completed` (processed)
- `files/state/app.db` (SQLite)
- `files/output.csv` (export)

## Local dev (Node)

- `npm install`
- `npm run dev`
  - Web: `http://localhost:5173`
  - API: `http://localhost:3000`

Production-style local run:
- `npm run build`
- `npm start` (serves the built web UI + API from `http://localhost:3000`)

## Filename date rule

The backend reads the chart date from the first `YYYY-MM-DD` found anywhere in the filename (e.g. `1986-04-12_top100.jpg`).
