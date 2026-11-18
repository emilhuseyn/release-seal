What I Built
I migrated Release Seal to XO (4 transactions) and built a new XO template for BCH Nostr ID (3 transactions). Both are running on chipnet, with 7 invitations passing the XO validator.
Top 3 Time-Consuming Issues

* SQLite Storage Error (#2): Setting `storageType: 'sqlite'` throws `listScriptHashes is not a function` during initialization. Switching back to the default storage got things running, though it meant I couldn't test persistent SQLite state.
* Uncaught Crash After `engine.stop()` (#3): Calling `engine.stop()` when a script finishes causes Node.js to crash with an empty `AggregateError`. Wrapping `stop()` in a `try/catch` does not help because the rejection fires asynchronously later from the block header sync. I had to add a global `unhandledRejection` handler just to let the process exit cleanly.
* Chipnet Min-Difficulty Header Sync (#4): Testnet's min-difficulty blocks confuse the block header validator and throw sync errors on recent chain tips. The coins themselves still work and spend fine, so this was mostly noise in the logs while debugging.

Other Friction Points

* Version Mismatch Across Docs and npm (#1): I lost time right at the start figuring out what to install. The documentation points to `0.1.0-next.17612568780`, the bounty page says `0.1.0-next.xxx`, and the `next` tag on npm installs `0.1.1-next.18029697917`, so it was unclear which release line was actually current.
* Silent Missing Fee Input on `sealRelease` (#13): `listMissingRequirements` returns an empty array for `sealRelease`, giving no warning that a fee input is missing. When broadcasting, the transaction gets rejected with `min relay fee not met (code 66)` because no fee input was attached automatically.
* Orphaned Coins on Template Changes (#8): Whenever I edited a template, its derived identifier changed and left previously funded coins orphaned under the old hash. I could still spend the old coin as an input in the updated template's invitation, which worked, but follow-up intents threw `LockingScriptSecretsNotFoundError`. This happened three times while I was fixing the template.

What Was Missing
There are no sample templates in the docs showing how to handle `OP_RETURN` outputs or CashTokens genesis. I worked around this by using a `p2s` locking script whose bytecode starts with `OP_RETURN`.
What Worked Well & Suggestions
The invitation model and the validator worked well once the templates were structured properly, and all 7 invitations passed validation.
A few practical additions that would save new builders a lot of time:

1. A Node.js "Getting Started" Section: A short, working Node.js example covering current package versions, storage setup, chipnet config, and clean shutdown.
2. Sample Templates for `OP_RETURN` and Tokens: Reference examples showing how to construct `OP_RETURN` payloads and CashTokens genesis transactions in XO.
3. Fee Requirement Checks in `listMissingRequirements`: Flagging missing fee inputs before broadcast so transactions do not fail silently until `code 66`.
