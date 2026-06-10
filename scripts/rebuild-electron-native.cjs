const { spawnSync } = require("node:child_process");

function getElectronVersion() {
  try {
    return require("electron/package.json").version;
  } catch {
    return "31.0.0";
  }
}

function getElectronBinary() {
  try {
    return require("electron");
  } catch {
    return null;
  }
}

function canLoadBetterSqliteInElectron() {
  const electronBinary = getElectronBinary();

  if (!electronBinary) {
    return false;
  }

  const result = spawnSync(
    electronBinary,
    [
      "-e",
      [
        "const Database=require('better-sqlite3');",
        "const db=new Database(':memory:');",
        "db.prepare('select 1').get();",
        "db.close();"
      ].join("")
    ],
    {
      stdio: "ignore",
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1"
      }
    }
  );

  return result.status === 0;
}

if (canLoadBetterSqliteInElectron()) {
  process.exit(0);
}

console.log("Rebuilding better-sqlite3 for Electron...");

const result = spawnSync("npm", ["rebuild", "better-sqlite3"], {
  stdio: "inherit",
  env: {
    ...process.env,
    npm_config_runtime: "electron",
    npm_config_target: getElectronVersion(),
    npm_config_disturl: "https://electronjs.org/headers"
  }
});

process.exit(result.status ?? 1);
