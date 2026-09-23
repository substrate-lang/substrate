# Rules for coding agents

These rules keep an agent's context and actions under the user's control.

- Commits and PR descriptions carry no Anthropic or Claude branding: no
  `Co-Authored-By: Claude` trailer, no session links, no "Generated with"
  lines.
- Get every tool from the Nix flake (`substrate/flake.nix`) and run it in
  the dev shell (`nix develop -c ...`). If a tool is missing, add it to the
  flake. Do not install anything globally.
- Stay inside this repository. Do not read, list or search files outside it
  unless the user asks.
- Do not write agent memory files. Project rules belong in this file.
