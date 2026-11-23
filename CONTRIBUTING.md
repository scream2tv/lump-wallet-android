# Contributing

Thank you for looking. This repository is public so that people who know wallets, Android or Midnight can read the
code and say what is wrong with it. Criticism is as welcome as code.

## Ways to help

- **Read and question.** The most useful starting points are [the security model](docs/SECURITY.md), the vault
  (`src/core/vault.ts`), the Cardano transaction checks (`src/core/cardanoTx.ts`), and the native in-app browser
  (`android/.../DappBrowserPlugin.java`).
- **Report a problem** in an issue: what you did, what you expected, what happened, the build number from the
  bottom of Settings, and your Android version.
- **Suggest** an improvement in a discussion or an issue before writing a large change, so nobody builds something
  that cannot be merged.
- **Security problems go through [private reporting](SECURITY.md), not public issues.**

Never post a recovery phrase, a PIN, or a screenshot that shows one. Nobody working on this project will ever ask
for them.

## Pull requests

1. Keep a change to one subject.
2. `npx tsc -b` must pass, and so must the self-contained tests (`node test/provider-proxy.mjs`,
   `node test/split.mjs`).
3. A change to anything that signs, stores keys, parses a transaction or talks to a site needs a test that fails
   without it.
4. Say in the description how you tested, and on what.

### Conventions

- TypeScript, no semicolons, comments that say why.
- React: do not define components inside components (the home screen redraws every second, and inline component
  types remount their subtree each time).
- The interface: dark, plain language, as few words as possible, no jargon where a plain word exists ("fee
  energy" for DUST, "private" and "public" for shielded and unshielded).
- No third-party wallet or product names in code or comments.
- Nothing that names a machine, a person or a private server belongs in the repository. Configuration that is
  specific to a deployment goes through environment variables ([Self-hosting](docs/SELF-HOSTING.md)).

## Licensing of contributions

By contributing you agree that your contribution is licensed under the [Apache License 2.0](LICENSE), as section 5
of the license describes.
