const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "src", "plugin.js");
execFileSync(process.execPath, ["--check", source], { stdio: "inherit" });
fs.copyFileSync(source, path.join(root, "main.js"));
