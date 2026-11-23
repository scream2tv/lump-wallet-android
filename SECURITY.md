# Reporting a vulnerability

Lump Wallet holds real funds. If you have found a way to take funds, read a recovery phrase, forge an approval,
or otherwise harm the people who use it, please tell us privately first.

## How to report

Use GitHub's private vulnerability reporting for this repository: the **Security** tab, then **Report a
vulnerability**. Only the maintainers see the report.

Please include:

- what an attacker can do, and what they need to do it;
- the steps or a proof of concept (against a throwaway wallet: never test against funds that are not yours);
- the build number (bottom of Settings) or the commit you looked at.

## What to expect

- An acknowledgement within a few days.
- An honest assessment, and a fix shipped to users before details are made public.
- Credit in the release notes if you want it.

There is no paid bounty programme at this stage of the project.

## Scope

In scope: the code in this repository (the app, the native shell, the server components).
Out of scope: problems in the Midnight wallet SDK, ledger, node, indexer or proof server themselves (report those
to their maintainers; we are glad to hear about them too), and attacks that need a device that is already fully
compromised.

The wallet's design limits that are already known are listed in [the security model](docs/SECURITY.md#known-limits).
