# Code Signing Policy

Free code signing provided by SignPath.io, certificate by SignPath Foundation.

## Scope

This policy covers official Optimizer Guard Windows installer and portable executable release assets built from this repository. Current releases remain unsigned until SignPath Foundation accepts the project. Signed releases will be identified in their release notes and verifiable with Windows Authenticode.

## Build and approval process

1. Release source is committed to the default branch and tagged.
2. GitHub Actions installs dependencies with `npm ci`, type-checks the project, and creates Windows packages on a clean runner.
3. The designated approver reviews the source revision and signing request.
4. SignPath signs only the approved executable artifacts with its HSM-protected key.
5. Signatures are verified before hashes and GitHub release assets are published.

## Project roles

- Committer and reviewer: [SyroxXploits](https://github.com/SyroxXploits)
- Signing approver: [SyroxXploits](https://github.com/SyroxXploits)

Third-party contributions require maintainer review before merge. Repository and signing accounts must use multi-factor authentication.

See the [privacy policy](PRIVACY.md) and [security policy](SECURITY.md).
