# Security

## Reporting a vulnerability

Please report security issues privately, not in a public issue:

- **Email:** security@darwin.finance.
- **GitHub private vulnerability reporting** on this repository ("Security" tab → "Report a vulnerability").
  It is enabled when the repository is public.

Include what you found, how to reproduce it, and which file or policy text it affects. We will acknowledge
your report, keep you informed while we investigate, and credit you when the fix ships unless you prefer
otherwise. Please give us a reasonable time to fix an issue before disclosing it.

## Scope

In scope: the permission templates in `src/permissions/` (anything a position's key could get Turnkey to
sign that the README says it cannot; the residuals the README lists are known), the verifier in `src/verify/` (anything that makes it pass policies
that do not match), and the strategy rules in `src/rules/`.

This repository is a mirror of production code. A fix is made in Darwin's production code first and then
mirrored here, so please report rather than open a pull request.

Never send private keys, seed phrases, passkey material or API keys in a report. The verifier only needs
public data: addresses, user ids and policy text.
