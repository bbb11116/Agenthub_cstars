import { promises as fs } from "node:fs";
import path from "node:path";
import { runCommand } from "../utils/commandRunner";

export const DEMO_APP_RELATIVE_PATH = "src/App.tsx";

export type DemoProjectFixture = {
  rootPath: string;
  appFilePath: string;
};

export const DEMO_APP_TSX = `import "./style.css";

export default function App() {
  return (
    <main className="demo-app">
      <section>
        <p className="eyebrow">AgentHub MVP</p>
        <h1>Local React Demo</h1>
        <p>Use the React Frontend Agent to propose a safe button style change.</p>
        <button type="button" className="primary-button">
          Start demo
        </button>
      </section>
    </main>
  );
}
`;

export const DEMO_STYLE_CSS = `:root {
  font-family: Inter, ui-sans-serif, system-ui, sans-serif;
  color: #1f2937;
  background: #f8fafc;
}

body {
  margin: 0;
}

.demo-app {
  display: grid;
  min-height: 100vh;
  place-items: center;
  padding: 48px;
}

.demo-app section {
  max-width: 520px;
}

.eyebrow {
  color: #64748b;
  font-size: 12px;
  font-weight: 800;
  text-transform: uppercase;
}

.primary-button {
  min-height: 44px;
  padding: 0 18px;
  border: 1px solid #475569;
  border-radius: 8px;
  color: #ffffff;
  background: #475569;
  font-weight: 800;
}
`;

export const DEMO_MAIN_TSX = `import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
`;

export const DEMO_INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>AgentHub Demo Project</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;

export const DEMO_PACKAGE_JSON = `{
  "name": "agenthub-demo-react-project",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite --host 127.0.0.1"
  },
  "dependencies": {
    "@vitejs/plugin-react": "^4.3.0",
    "vite": "^5.4.0",
    "typescript": "^5.5.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  }
}
`;

export async function createDemoReactProject(
  rootPath: string
): Promise<DemoProjectFixture> {
  const resolvedRootPath = path.resolve(rootPath);
  const sourcePath = path.join(resolvedRootPath, "src");

  await fs.mkdir(sourcePath, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(resolvedRootPath, "package.json"), DEMO_PACKAGE_JSON, "utf8"),
    fs.writeFile(path.join(resolvedRootPath, "index.html"), DEMO_INDEX_HTML, "utf8"),
    fs.writeFile(path.join(sourcePath, "main.tsx"), DEMO_MAIN_TSX, "utf8"),
    fs.writeFile(path.join(sourcePath, "style.css"), DEMO_STYLE_CSS, "utf8"),
    fs.writeFile(path.join(sourcePath, "App.tsx"), DEMO_APP_TSX, "utf8")
  ]);

  return {
    rootPath: resolvedRootPath,
    appFilePath: path.join(resolvedRootPath, DEMO_APP_RELATIVE_PATH)
  };
}

export async function initializeDemoGitRepository(rootPath: string): Promise<void> {
  const resolvedRootPath = path.resolve(rootPath);

  await runCommand("git", ["init"], { cwd: resolvedRootPath });
  await runCommand("git", ["add", "."], { cwd: resolvedRootPath });
  await runCommand(
    "git",
    [
      "-c",
      "user.email=agenthub@example.test",
      "-c",
      "user.name=AgentHub Demo",
      "commit",
      "-m",
      "initial demo project"
    ],
    { cwd: resolvedRootPath }
  );
}
