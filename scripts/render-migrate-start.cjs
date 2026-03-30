/**
 * Back-compat entry: older Render "Start Command" pointed here.
 * Prefer: npm run render:start  OR  node scripts/render-start.cjs
 * Do not append "&& node apps/api/dist/main.js" — the script already starts the API.
 */
"use strict";
require("./render-start.cjs");
