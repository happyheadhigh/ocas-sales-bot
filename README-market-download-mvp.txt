market-download-mvp files

This zip adds a safe wrapper around the existing OCAS bot without replacing bot.js.

Files:
- bot-market-download.js: new wrapper that adds /market, /download, sales polling, and an OCAS Download PNG button.
- register-commands.js: replacement slash command registration with /market and /download added.
- package.json: replacement package config that starts bot-market-download.js by default.

Branch target:
- market-download-mvp only

Do not put these on main yet.
