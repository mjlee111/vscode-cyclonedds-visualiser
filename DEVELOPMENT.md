# Development

Notes for working on the extension. User documentation is in [README.md](README.md).

## Layout

```
src/core/        backend process, frame protocol, request/subscription hub (no VS Code API)
src/vscode/      activation, commands, DDS explorer, webview panels
src/harness/     dev server: runs the panels in a browser against the real backend
shared/          protocol types shared by host and webviews
webview/         one entry point per panel (+ common/ helpers), bundled by esbuild
python/          dds_backend.py (cyclonedds), dds_demo.py (demo application)
test/            backend protocol test, extension host test, browser UI test, loopback Cyclone config
scripts/         build, screenshots, icon rendering
media/           icons (media/src/icon.svg is the icon source), README screenshots
```

## Build

```bash
npm install
npm run build          # dist/extension.js, dist/webview/*, dist/harness.js
npm run typecheck
```

Press **F5** (*Run Extension*) to start an Extension Development Host.

## Tests

The tests use the loopback-only configuration `test/cyclonedds-test.xml`, so no DDS traffic leaves the machine. `npm test` starts its own demo application on domain 88.

```bash
npm test                                           # backend protocol test + extension host test (stubbed vscode API)

export CYCLONEDDS_URI=file://$PWD/test/cyclonedds-test.xml DDS_VIS_DOMAIN=87
/usr/bin/python3 python/dds_demo.py --domain 87 &
node dist/harness.js --port 8766 &                 # panels at http://localhost:8766/view/<name>[?args={...}]
npm run test:ui                                    # headless Chrome UI test against the harness
```

The interpreter used by the tests must have the `cyclonedds` package (`DDS_VIS_PYTHON` overrides it for the harness). The UI test and the screenshot script use `/usr/bin/google-chrome` through `playwright-core`.

## Screenshots and icon

```bash
node scripts/screenshots.mjs media/screenshots [name ...]   # needs the demo and the harness
node scripts/render-icon.mjs                                # media/src/icon.svg -> media/icon.png
```

README images are referenced relative to the repository. `vsce` rewrites them to `https://github.com/mjlee111/vscode-cyclonedds-visualiser/raw/HEAD/...`, so they must be pushed before publishing.

## Release

1. Update `version` in `package.json` and add a section to `CHANGELOG.md`.
2. `npm run package` and check the `.vsix` locally (`code --install-extension cyclonedds-visualiser-<version>.vsix --force`).
3. Push, then publish a GitHub release with tag `v<version>`. `.github/workflows/publish.yml` checks that the tag matches `package.json`, packages, and publishes with Marketplace Trusted Publishing (OIDC). The publisher `mjlee111` needs a Trusted Publishing policy for this repository and workflow file.
