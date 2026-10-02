# Changelog

## Unreleased

- Removed hard-coded README test and conformance counts so they stay accurate as coverage grows.
- Added the prepared `input` field to the README's unpaid `402` response shape.
- Expanded the README test to run the conformance commands and the library example, using the exported test bearer token.
- Updated the manual request examples to use the supported `job.open` action.
- Documented the current check response shape: `{action, blockers, suggestions, kind, plan, facts, judged}`.
- Replaced all legacy `echo` and `implement` action references with the current action catalogue and state transitions.
- Added the open question about whether the live API, like the mock, changes an order to `payment_pending` after an unpaid `402` submit.
- Added coverage that executes the README's hand-run commands against the mock.
