# Legacy helper scripts

Optional / superseded utilities kept out of the main `scripts/` surface.

## Doc helpers

- `convert_docs.py` / `docx_to_text.py` — Markdown ↔ DOCX helpers
- `bring-desktop-front.ps1` — Windows focus helper for the desktop window

## Desktop installers (do not ship)

Superseded by `../build-desktop-installer-csharp-wizard.ps1`:

- `build-desktop-installer-csharp.ps1`
- `build-desktop-installer-nsis.ps1`
- `build-desktop-installer-iexpress.ps1`

These scripts resolve the repo root as `../..` and write artifacts to `scripts/deploy-artifacts/`.
