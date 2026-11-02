#!/bin/sh
# Starts the board with file persistence. Everything you change is written to
# tasks.json, with a timestamped backup taken before every write.
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || { echo "Node is not installed. Open project-plan-dashboard.html in your browser instead."; exit 1; }
(sleep 1; (command -v xdg-open >/dev/null 2>&1 && xdg-open http://localhost:8080/project-plan-dashboard.html) \
        || (command -v open >/dev/null 2>&1 && open http://localhost:8080/project-plan-dashboard.html)) &
node serve-dashboard.js
