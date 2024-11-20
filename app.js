import 'dotenv/config';
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import { WebClient } from '@slack/web-api';

// Set up GitHub App credentials
const appId = process.env.GH_APP_ID; // GitHub App ID
const installationId = process.env.GH_INSTALLATION_ID; // GitHub App Installation ID
const privateKey = process.env.GH_PRIVATE_KEY; // GitHub Private Key

// Set up Slack credentials
const slackToken = process.env.SLACK_TOKEN; // Slack Bot User OAuth Token
const slackChannel = process.env.SLACK_CHANNEL; // Slack channel to post messages

// List of repositories to query (can include multiple orgs)
const repos = process.env.GH_REPOS.split(','); // Expected format: "org1/repo1,org2/repo2,..."

// List of team members to filter PRs
const teamMembers = process.env.GH_TEAM_MEMBERS.split(','); // Expected format: "user1,user2,..."

// List of teams to filter PRs (e.g., GitHub teams)
const teams = process.env.GH_TEAMS.split(','); // Expected format: "team1,team2,..."

// Mapping GitHub usernames to Slack usernames
const githubToSlackMap = JSON.parse(process.env.GH_TO_SLACK_USER_MAP); // Expected format: "{\"githubUser1\": \"slackUser1\", ...}"

// Configurable thresholds
const approvalThreshold = parseInt(process.env.APPROVAL_THRESHOLD) || 2;
const oldPRThresholdDays = parseInt(process.env.OLD_PR_THRESHOLD_DAYS) || 7;

const enableLogging = process.env.ENABLE_MESSAGE_LOGGING === 'true'; // Defaults to false
const enableSlackPosting = process.env.ENABLE_SLACK_POSTING !== 'false'; // Defaults to true

const timeSince = (date) => {
  const seconds = Math.floor((new Date() - new Date(date)) / 1000);
  let interval = Math.floor(seconds / 31536000);

  if (interval > 1) {
    return `${interval} years ago`;
  }
  interval = Math.floor(seconds / 2592000);
  if (interval > 1) {
    return `${interval} months ago`;
  }
  interval = Math.floor(seconds / 86400);
  if (interval > 1) {
    return `${interval} days ago`;
  }
  interval = Math.floor(seconds / 3600);
  if (interval > 1) {
    return `${interval} hours ago`;
  }
  interval = Math.floor(seconds / 60);
  if (interval > 1) {
    return `${interval} minutes ago`;
  }
  return `${seconds} seconds ago`;
};

const formatPRDetails = (pr) => {
  return `• *<${pr.html_url}|${pr.base.repo.name}-${pr.number}: ${pr.title}>* by _${pr.user.login}_ - Opened ${timeSince(pr.created_at)}, Last updated ${timeSince(pr.updated_at)}`;
};

(async () => {
  try {
    // Generate installation token
    const auth = createAppAuth({
      appId,
      privateKey,
    });

    const installationAuth = await auth({
      type: 'installation',
      installationId,
    });

    // Create a GH client
    const github = new Octokit({
      auth: installationAuth.token,
    });

    // Create a Slack client
    const slackClient = new WebClient(slackToken);

    // List to collect all matching PRs
    const matchingPRs = [];

    // Iterate over repositories and fetch PRs
    for (const repo of repos) {
      const [owner, repoName] = repo.split('/');

      // Fetch all open pull requests in the repository
      const pullRequests = await github.paginate(github.rest.pulls.list, {
        owner,
        repo: repoName,
        state: 'open',
        per_page: 100,
      });

      // Iterate over pull requests and collect matching PRs
      for (const pr of pullRequests) {
        // Exclude draft PRs
        if (pr.draft) {
          continue;
        }

        // Check if PR is opened by a team member
        const isOpenedByTeamMember = teamMembers.includes(pr.user.login);

        // Check if review is requested from configured team members or teams
        const pendingReviewers = pr.requested_reviewers ? pr.requested_reviewers.map(reviewer => reviewer.login) : [];
        const pendingTeamReviewers = pr.requested_teams ? pr.requested_teams.map(team => team.name) : [];

        if (isOpenedByTeamMember || pendingReviewers.some(reviewer => teamMembers.includes(reviewer)) || pendingTeamReviewers.some(team => teams.includes(team))) {
          matchingPRs.push(pr);
        }
      }
    }

    // Sort matching PRs from oldest to newest
    matchingPRs.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    // Categorize PRs
    const olderPRs = [];
    const approvedPRs = [];
    const changesRequestedPRs = [];
    const otherPRs = [];

    const oldPRThresholdDate = new Date();
    oldPRThresholdDate.setDate(oldPRThresholdDate.getDate() - oldPRThresholdDays);

    // Break up PRs into categories
    for (const pr of matchingPRs) {
      const reviews = await github.rest.pulls.listReviews({
        owner: pr.base.repo.owner.login,
        repo: pr.base.repo.name,
        pull_number: pr.number,
      });

      // Track the latest review for each user
      const latestReviewByUser = new Map();
      for (const review of reviews.data) {
        const reviewDate = new Date(review.submitted_at);
        if (!latestReviewByUser.has(review.user.login) || new Date(review.submitted_at) > new Date(latestReviewByUser.get(review.user.login).submitted_at)) {
          latestReviewByUser.set(review.user.login, review);
        }
      }

      // Determine the final state of reviews
      const latestReviews = Array.from(latestReviewByUser.values());

      // Check if PR has changes requested that are not overridden
      const hasChangesRequested = latestReviews.some(review => review.state === 'CHANGES_REQUESTED');
      if (hasChangesRequested) {
        changesRequestedPRs.push(pr);
        continue;
      }

      // Check if PR has >= 2 approvals
      const approvals = latestReviews.filter(review => review.state === 'APPROVED');
      if (approvals.length >= approvalThreshold) {
        approvedPRs.push(pr);
        continue;
      }

      // Check if PR is older than X days
      const createdAt = new Date(pr.created_at);
      if (createdAt < oldPRThresholdDate) {
        olderPRs.push(pr);
        continue;
      }

      // Add to other PRs if it doesn't match any above criteria
      otherPRs.push(pr);
    }

    // Generate Slack summary message
    let summaryMessage = `*PR Summary for Team*
Total PRs: ${matchingPRs.length}
`;

    if (changesRequestedPRs.length > 0) {
      summaryMessage += `
*PRs with Changes Requested*
`;
      for (const pr of changesRequestedPRs) {
        summaryMessage += `${formatPRDetails(pr)}
`;
      }
    }

    if (approvedPRs.length > 0) {
      summaryMessage += `
*PRs with >= ${approvalThreshold} Approvals*
`;
      for (const pr of approvedPRs) {
        summaryMessage += `${formatPRDetails(pr)}
`;
      }
    }

    if (olderPRs.length > 0) {
      summaryMessage += `
*Older PRs (over ${oldPRThresholdDays} days)*
`;
      for (const pr of olderPRs) {
        summaryMessage += `${formatPRDetails(pr)}
`;
      }
    }

    if (otherPRs.length > 0) {
      summaryMessage += `
*Everything Else*
`;
      for (const pr of otherPRs) {
        summaryMessage += `${formatPRDetails(pr)}
`;
      }
    }

    // Log main summary message for debugging purposes
    if (enableLogging) {
      console.log(summaryMessage);
      console.log('========================================');
    }

    if (enableSlackPosting) {
      const summaryResponse = await slackClient.chat.postMessage({
        channel: slackChannel,
        text: summaryMessage,
        unfurl_links: false,
        unfurl_media: false,
      });

      const individualMessages = {};

      for (const pr of matchingPRs) {
        const prDetails = formatPRDetails(pr);

        // Add individual Slack messages for team members assigned to PRs
        const pendingReviewers = pr.requested_reviewers ? pr.requested_reviewers.map(reviewer => reviewer.login) : [];
        const assignedTeamMembers = pendingReviewers.filter(reviewer => teamMembers.includes(reviewer));

        assignedTeamMembers.forEach(assignee => {
          const slackUser = githubToSlackMap[assignee];
          if (slackUser) {
            if (!individualMessages[slackUser]) {
              individualMessages[slackUser] = {
                assignedPRs: [],
                approvedPRs: [],
                changesRequestedPRs: [],
              };
            }
            individualMessages[slackUser].assignedPRs.push(prDetails);
          }
        });

        // Include PRs with >= 2 approvals in individual messages
        if (approvedPRs.includes(pr)) {
          const slackUser = githubToSlackMap[pr.user.login];
          if (slackUser) {
            if (!individualMessages[slackUser]) {
              individualMessages[slackUser] = {
                assignedPRs: [],
                approvedPRs: [],
                changesRequestedPRs: [],
              };
            }
            individualMessages[slackUser].approvedPRs.push(prDetails);
          }
        }

        // Include PRs with changes requested in individual messages for the PR author
        if (changesRequestedPRs.includes(pr)) {
          const slackUser = githubToSlackMap[pr.user.login];
          if (slackUser) {
            if (!individualMessages[slackUser]) {
              individualMessages[slackUser] = {
                assignedPRs: [],
                approvedPRs: [],
                changesRequestedPRs: [],
              };
            }
            individualMessages[slackUser].changesRequestedPRs.push(prDetails);
          }
        }
      }

      for (const [slackUser, messages] of Object.entries(individualMessages)) {
        let individualMessage = `Hey <@${slackUser}>, you have the following PRs to take a closer look at:
`;
        if (messages.approvedPRs.length > 0) {
          individualMessage += `*Your PRs with >= ${approvalThreshold} Approvals (Probably Ready to Merge):*
${messages.approvedPRs.join('\n')}
`;
        }
        if (messages.changesRequestedPRs.length > 0) {
          individualMessage += `*Your PRs with Changes Requested:*
${messages.changesRequestedPRs.join('\n')}
`;
        }
        if (messages.assignedPRs.length > 0) {
          individualMessage += `*Directly Requested Review:*
${messages.assignedPRs.join('\n')}
`;
        }

        // Log individual message for debugging purposes
        if (enableLogging) {
          console.log(individualMessage);
          console.log('----------------------------------------');
        }

        // Post the individual message as a thread response to the summary message
        if (enableSlackPosting) {
          await slackClient.chat.postMessage({
            channel: slackChannel,
            text: individualMessage,
            unfurl_links: false,
            unfurl_media: false,
            thread_ts: summaryResponse.ts,
          });
        }
      }
    }
  }
  catch (error) {
    console.error('Error while compiling PR report:', error);
  }
})();
