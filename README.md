# LoRELEI Demo Website

Marketing and demo website for LoRELEI - GPS race tracking system using LoRa mesh networking.

## Live Site

Hosted at: https://npines.io (Cloudflare Pages)

## Features

- **Landing Page**: Marketing content, feature overview, demo links
- **Race Replays**: Interactive satellite map replays of real race data
  - YO Ranch Trial (4 runners, November 2025)
  - 772 Endurance Race (12 runners, 2 days, December 2025)

## Replay Features

- Play/pause with variable speed (1x to 60x)
- Timeline scrubbing
- Follow specific runner or auto-fit all runners
- Runner filtering
- Geofence visualization (start, finish, stages)
- Trail history for each runner

## Project Structure

```
lorelei-demo/
├── index.html              # Landing page
├── replay-yoranch.html     # YO Ranch replay
├── replay-772.html         # 772 race replay (with day selector)
├── css/
│   ├── main.css            # Global styles
│   └── replay.css          # Replay module styles
├── js/
│   ├── replay-core.js      # Playback engine
│   ├── replay-map.js       # Leaflet map integration
│   └── replay-controls.js  # UI controls
├── data/
│   ├── yoranch/            # YO Ranch race data
│   └── 772/                # 772 race data (day1, day2)
└── tools/
    └── export_race_data.py # Data export utility
```

## Technology Stack

- Vanilla JavaScript (no framework)
- Leaflet 1.9.4 for maps
- Esri World Imagery satellite tiles
- CSS Custom Properties for theming
- Static hosting (Cloudflare Pages)

## Data Export

The `tools/export_race_data.py` script exports race data from the LoreleiV2 SQLite database to JSON files for the static website.

```bash
# List available race resets
python tools/export_race_data.py --list-resets

# Export configured races
python tools/export_race_data.py --export
```

## Local Development

Open `index.html` in a web browser. For proper data loading, serve with a local HTTP server:

```bash
# Python 3
python -m http.server 8000

# Then open http://localhost:8000
```

## Deployment

Push to the `main` branch. Cloudflare Pages auto-deploys on push.

## Related Repositories

- [LoreleiV2](https://github.com/Npineseng/LoreleiV2) - Base station software
- [RAKFirmware](https://github.com/Npineseng/RAKFirmware) - GPS node firmware
- [Docs](https://github.com/Npineseng/Docs) - Documentation

---

Nein Pines | npines.io
