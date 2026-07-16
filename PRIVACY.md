# Privacy

Optimizer Guard does not include advertising, analytics, or maintainer-operated telemetry.

## Data stored locally

The application reads Windows configuration, scheduled tasks, installed applications, hardware information, and selected cleanup locations to provide its features. Settings, action logs, restore history, and scan results are stored locally in Electron's application-data directory.

Demo screenshot mode uses generated data so real task names, hardware details, usernames, and paths are not published with repository screenshots.

## Network connections

The application contacts the public GitHub Releases API for `SyroxXploits/Optimizer-Guard` when checking for updates. It can also open project or release links in the user's default browser. No local system inventory or action log is sent with those requests.

The maintainer does not receive application data unless a user deliberately includes it in a support or security report.

## User control

Users can inspect or delete the application's local data directory. External sites opened by the user are governed by their own privacy policies.
