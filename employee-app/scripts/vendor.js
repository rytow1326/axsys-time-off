// Copies browser builds of runtime libraries into renderer/vendor so the page
// loads them from inside the app (no CDN, works offline / behind firewalls).
const fs = require("fs");
const path = require("path");
const out = path.join(__dirname, "..", "renderer", "vendor");
fs.mkdirSync(out, { recursive: true });
const src = path.join(__dirname, "..", "node_modules", "@supabase", "supabase-js", "dist", "umd", "supabase.js");
if (!fs.existsSync(src)) { console.error("supabase-js browser build not found — run npm install"); process.exit(1); }
fs.copyFileSync(src, path.join(out, "supabase.js"));
console.log("Copied supabase.js into renderer/vendor");
