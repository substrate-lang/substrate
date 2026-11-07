# Rules for coding agents

These rules keep an agent's context and actions under the user's control.

- Commits and PR descriptions carry no Anthropic or Claude branding: no
  `Co-Authored-By: Claude` trailer, no session links, no "Generated with"
  lines.
- Get every tool from the Nix flake (`flake.nix`) and run it in
  the dev shell (`nix develop -c ...`). If a tool is missing, add it to the
  flake. Do not install anything globally.
- Stay inside this repository. Do not read, list or search files outside it
  unless the user asks.
- Do not write agent memory files. Project rules belong in this file.
- Non-trivial English entering the repository must be approved by the user.
- Any English in comments, docs, or commits should be human-like: avoid
  chained clauses, recursive statements, elided verbs or objects, etc.
- Avoid comments in most code. A comment is a short, concrete label: what a
  file, section or value is, or where related code lives. No explanations in
  comments unless the user asks.
- Commit messages are one short line.
