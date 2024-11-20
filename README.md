# PR Poker

PR Poker (as in "to poke") is a tool designed to facilitate pull request (PR) reminders for teams. It integrates with GitHub to gather information about open PRs in your repositories and sends notifications to a designated Slack channel to improve visibility and help streamline the review process.

## Features

- **Categorizes PRs** into various states: PRs with changes requested, PRs ready to merge (based on approval count), older PRs, and others.
- **Slack Integration**: Posts a summary of PRs to a Slack channel and notifies individual reviewers directly in thread responses to the summary message (to reduce channel noise).
- **Configurable Settings** for Slack notifications, GitHub repositories, and team members.
- **Customizable Thresholds** for PR approvals and age to determine categorization.
- **Detailed Logging** using Winston, with configurable log levels to control verbosity, including detailed error stack traces for debugging.

## Setup

### Prerequisites

- Node.js installed (v16 or above recommended).
- GitHub App credentials and a Slack Bot User OAuth Token.

### Environment Variables

Create a `.env` file in the root directory and define the following environment variables:

```env
# GitHub App credentials
GH_APP_ID=your_github_app_id
GH_INSTALLATION_ID=your_installation_id
GH_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEAr9N...
...
-----END RSA PRIVATE KEY-----"

# Slack credentials
SLACK_TOKEN=your_slack_bot_token
SLACK_CHANNEL=your_slack_channel_id

# GitHub repository and team configurations
GH_REPOS=org1/repo1,org2/repo2
GH_TEAM_MEMBERS=user1,user2
GH_TEAMS=team1,team2
GH_TO_SLACK_USER_MAP="{\"githubUser1\": \"slackUser1\", \"githubUser2\": \"slackUser2\"}"

# Configurable thresholds
APPROVAL_THRESHOLD=2
OLD_PR_THRESHOLD_DAYS=7

# Optional settings
ENABLE_MESSAGE_LOGGING=true # Logs Slack messages to console for debugging purposes; defaults to "false"
ENABLE_SLACK_POSTING=true   # Set to "false" to NOT post messages to Slack; defaults to "true"
LOG_LEVEL=info              # Set the logging level; can be "error", "warn", "info", "debug", "silly"
```

### Installation

1. Clone the repository:

   ```sh
   git clone <repository-url>
   cd pr-poker
   ```

2. Install the dependencies:

   ```sh
   npm install
   ```

3. Run the script:

   ```sh
   npm start
   ```

## How It Works

- The script authenticates with GitHub using a GitHub App.
- It queries specified repositories to fetch open PRs and categorizes them based on:
  - Whether there are requested changes.
  - Whether the PR has a sufficient number of approvals.
  - If the PR is older than a configurable threshold.
- A Slack summary message is sent to a channel, and individual team members are notified about PRs assigned to them or those needing further action.
- **Logging**: The tool uses Winston for logging, allowing for configurable log levels (`error`, `warn`, `info`, `debug`, `silly`). Error stack traces are logged to help with debugging.

## Environment Variables Explained

- **GH\_APP\_ID, GH\_INSTALLATION\_ID, GH\_PRIVATE\_KEY**: Credentials for authenticating the GitHub App.
- **SLACK\_TOKEN, SLACK\_CHANNEL**: Slack Bot token and channel to post notifications.
- **GH\_REPOS**: Comma-separated list of repositories to monitor for PRs.
- **GH\_TEAM\_MEMBERS, GH\_TEAMS**: Lists of GitHub usernames and teams whose PRs are being tracked.
- **GH\_TO\_SLACK\_USER\_MAP**: JSON mapping of GitHub usernames to Slack usernames for individual notifications.
  - **Important Note:** Slack username must be internal Slack user ID (e.g. "U081YAAAAAA")
- **APPROVAL\_THRESHOLD**: Number of approvals needed for a PR to be considered ready for merge.
- **OLD\_PR\_THRESHOLD\_DAYS**: Number of days for a PR to be considered "old".
- **ENABLE\_MESSAGE\_LOGGING**: If set to `true`, logs generated messages to the console for debugging purposes (defaults to `false`).
- **ENABLE\_SLACK\_POSTING**: If set to `false`, disables sending messages to Slack (defaults to `true`).
- **LOG\_LEVEL**: Defines the logging level (`error`, `warn`, `info`, `debug`, `silly`); helps control the verbosity of logs.

## Example Workflow

- Every morning, the script runs and queries all open PRs in the specified repositories.
- A summary is posted to a designated Slack channel, listing PRs that:
  - Have changes requested.
  - Have sufficient approvals to be merged.
  - Are older than the defined threshold.
- Individual Slack messages are posted as responses to summary message and @-mention Slack users for PRs that are relevant to them specifically.

## Contributing

Feel free to contribute by forking the repository and opening a pull request. Contributions to improve functionality, fix bugs, or add features are welcome!

## Troubleshooting

- **Error: Missing environment variable**: Ensure that all required environment variables are properly defined in the `.env` file.
- **Slack messages not posting**: Verify that `ENABLE_SLACK_POSTING` is not set to "false" and that Slack credentials are correct.
- **GitHub authentication issues**: Double-check that your GitHub App ID, installation ID, and private key are correctly set.
- **No log messages appearing**: Ensure that `LOG_LEVEL` is set appropriately and that the console transport is included in the Winston logger configuration.

## Contact

For further assistance, please open an issue on GitHub.