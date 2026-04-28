# anarchy-web (IMPORTANT : THIS IS A VIBE-CODED PROJECT)

Browser frontend for **Project Anarchy** — a real-time multiplayer game played in the browser. Written in TypeScript, rendered with [Three.js](https://threejs.org/), bundled with [Vite](https://vitejs.dev/).

This repo currently contains a stand-alone hello world: a rotating cube. The game server lives in a separate repo (`anarchy-server`), and the two will eventually communicate over WebSocket using protobuf — neither piece is wired up yet.

## Prerequisites

- [Node.js](https://nodejs.org/) 22+ (with `npm`).
- [Docker](https://www.docker.com/) — only required if you want to run the production-style container.

## Local development

```sh
npm install
npm run dev
```

Then open http://localhost:5173. Vite serves with HMR — edits to `src/main.ts` reload immediately.

## Production build

```sh
npm run build
```

Output is emitted to `dist/`. To preview the built bundle locally:

```sh
npm run preview
```

## Docker

The Dockerfile is a two-stage build: Node compiles the TypeScript bundle, then `nginx:alpine` serves the static `dist/`.

```sh
docker build -t anarchy-web .
docker run --rm -p 8080:80 anarchy-web
```

Open http://localhost:8080.

## Project structure

```
anarchy-web/
├── index.html          # Vite entry point
├── package.json
├── tsconfig.json
├── vite.config.ts
├── Dockerfile
└── src/
    └── main.ts         # Three.js scene
```
