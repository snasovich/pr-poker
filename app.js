import 'dotenv/config';
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import { WebClient } from '@slack/web-api';
import { formatDistanceToNow } from 'date-fns';
import winston from 'winston';

// Set up logging
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, stack }) => {
      return stack
      ? `${timestamp} [${level.toUpperCase()}]: ${message}\n${stack}`
      : `${timestamp} [${level.toUpperCase()}]: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console({
      forceConsole: true
    })
  ],
});

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
const teamMembers = process.env.GH_TEAM_MEMBERS ? process.env.GH_TEAM_MEMBERS.split(',') : []; // Expected format: "user1,user2,..."

// List of teams to filter PRs (e.g., GitHub teams)
const teams = process.env.GH_TEAMS ? process.env.GH_TEAMS.split(',') : []; // Expected format: "team1,team2,..."

// Mapping GitHub usernames to Slack usernames
const githubToSlackMap = JSON.parse(process.env.GH_TO_SLACK_USER_MAP); // Expected format: "{\"githubUser1\": \"slackUser1\", ...}"

// Configurable thresholds
const approvalThreshold = parseInt(process.env.APPROVAL_THRESHOLD) || 2;
const oldPRThresholdDays = parseInt(process.env.OLD_PR_THRESHOLD_DAYS) || 7;

// Flags
const enableMessageLogging = process.env.ENABLE_MESSAGE_LOGGING === 'true'; // Defaults to false
const enableSlackPosting = process.env.ENABLE_SLACK_POSTING !== 'false'; // Defaults to true

const timeSince = (date) => {
  return formatDistanceToNow(new Date(date), { addSuffix: true });
};

const formatPRDetails = (pr) => {
  return `• *<${pr.html_url}|${pr.base.repo.name}-${pr.number}: ${pr.title}>* by _${pr.user.login}_ - Opened ${timeSince(pr.created_at)}, Last updated ${timeSince(pr.updated_at)}`;
};

(async () => {
  try {
    logger.info('Starting PR Poker script');

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

      logger.debug(`Fetching PRs for repository: ${owner}/${repoName}`);

      // Fetch all open pull requests in the repository
      const pullRequests = await github.paginate(github.rest.pulls.list, {
        owner,
        repo: repoName,
        state: 'open',
        per_page: 100,
      });

      logger.info(`Found total ${pullRequests.length} PRs for repository: ${owner}/${repoName}`);
      
      // Iterate over pull requests and collect matching PRs
      let repoMatchingPRsCount = 0;
      for (const pr of pullRequests) {
        // Exclude draft PRs
        if (pr.draft) {
          logger.debug(`Skipped draft PR ${pr.html_url}`);
          continue;
        }

        // Check if PR is opened by a team member
        const isOpenedByTeamMember = teamMembers.includes(pr.user.login);

        // Check if review is requested from configured team members or teams
        const pendingReviewers = pr.requested_reviewers ? pr.requested_reviewers.map(reviewer => reviewer.login) : [];
        const pendingTeamReviewers = pr.requested_teams ? pr.requested_teams.map(team => team.name) : [];

        if (isOpenedByTeamMember || pendingReviewers.some(reviewer => teamMembers.includes(reviewer)) || pendingTeamReviewers.some(team => teams.includes(team))) {
          logger.debug(`PR ${pr.html_url} is a match`);
          repoMatchingPRsCount++;
          matchingPRs.push(pr);
        } else {
          logger.debug(`PR ${pr.html_url} is NOT a match`);
        }
      }

      logger.info(`${repoMatchingPRsCount} from ${owner}/${repoName} repo are a match`);
    }

    logger.info(`Total ${matchingPRs.length} matching PRs found`);

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
    logger.info(`Categorizing PRs`);

    for (const pr of matchingPRs) {
      logger.debug(`Categorizing PR ${pr.html_url}; querying reviews`);
      const reviews = await github.rest.pulls.listReviews({
        owner: pr.base.repo.owner.login,
        repo: pr.base.repo.name,
        pull_number: pr.number,
      });
      logger.debug(`${reviews.data.length} reviews found for PR ${pr.html_url}`);

      // Track the latest review for each user
      const latestReviewByUser = new Map();
      for (const review of reviews.data) {
        if (!latestReviewByUser.has(review.user.login) || new Date(review.submitted_at) > new Date(latestReviewByUser.get(review.user.login).submitted_at)) {
          latestReviewByUser.set(review.user.login, review);
        }
      }

      // Determine the final state of reviews
      const latestReviews = Array.from(latestReviewByUser.values());

      // Check if PR has changes requested that are not overridden
      const hasChangesRequested = latestReviews.some(review => review.state === 'CHANGES_REQUESTED');
      if (hasChangesRequested) {
        logger.debug(`PR has changes requested: ${pr.html_url}`);
        changesRequestedPRs.push(pr);
        continue;
      }

      // Check if PR has >= 2 approvals
      const approvals = latestReviews.filter(review => review.state === 'APPROVED');
      if (approvals.length >= approvalThreshold) {
        logger.debug(`PR has sufficient approvals: ${pr.html_url}`);
        approvedPRs.push(pr);
        continue;
      }

      // Check if PR is older than X days
      const createdAt = new Date(pr.created_at);
      if (createdAt < oldPRThresholdDate) {
        logger.debug(`PR is older than ${oldPRThresholdDays} days: ${pr.html_url}`);
        olderPRs.push(pr);
        continue;
      }

      // Add to other PRs if it doesn't match any above criteria
      logger.debug(`PR does not match any specific category: ${pr.html_url}`);
      otherPRs.push(pr);
    }

    logger.debug("Generating summary message");

    // Generate Slack summary message
    let summaryMessage = `*PR Summary for Team*\nTotal PRs: ${matchingPRs.length}\n`;

    if (changesRequestedPRs.length > 0) {
      summaryMessage += `\n*PRs with Changes Requested*\n`;
      for (const pr of changesRequestedPRs) {
        summaryMessage += `${formatPRDetails(pr)}\n`;
      }
    }

    if (approvedPRs.length > 0) {
      summaryMessage += `\n*PRs with >= ${approvalThreshold} Approvals*\n`;
      for (const pr of approvedPRs) {
        summaryMessage += `${formatPRDetails(pr)}\n`;
      }
    }

    if (olderPRs.length > 0) {
      summaryMessage += `\n*Older PRs (over ${oldPRThresholdDays} days)*\n`;
      for (const pr of olderPRs) {
        summaryMessage += `${formatPRDetails(pr)}\n`;
      }
    }

    if (otherPRs.length > 0) {
      summaryMessage += `\n*Everything Else*\n`;
      for (const pr of otherPRs) {
        summaryMessage += `${formatPRDetails(pr)}\n`;
      }
    }

    logger.info('Generated summary message for Slack');
    if (enableMessageLogging) {
      logger.info(summaryMessage);
    }

    let summaryResponse;
    // Post summary message to Slack
    if (enableSlackPosting) {
      summaryResponse = await slackClient.chat.postMessage({
        channel: slackChannel,
        text: summaryMessage,
        unfurl_links: false,
        unfurl_media: false,
      });

      logger.info('Posted summary message to Slack');
    }

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
      let individualMessage = `Hey <@${slackUser}>, you have the following PRs to take a closer look at:\n`;
      if (messages.approvedPRs.length > 0) {
        individualMessage += `*Your PRs with >= ${approvalThreshold} Approvals (Probably Ready to Merge):*\n${messages.approvedPRs.join('\n')}\n`;
      }
      if (messages.changesRequestedPRs.length > 0) {
        individualMessage += `*Your PRs with Changes Requested:*\n${messages.changesRequestedPRs.join('\n')}\n`;
      }
      if (messages.assignedPRs.length > 0) {
        individualMessage += `*Directly Requested Review:*\n${messages.assignedPRs.join('\n')}\n`;
      }

      logger.info(`Generated individual message for Slack user: ${slackUser}`);
      if (enableMessageLogging) {
        logger.info(individualMessage);
      }

      // Post the individual message as a thread response to the summary message
      if (enableSlackPosting && summaryResponse) {
        await slackClient.chat.postMessage({
          channel: slackChannel,
          text: individualMessage,
          unfurl_links: false,
          unfurl_media: false,
          thread_ts: summaryResponse.ts,
        });
        logger.info(`Posted individual message for Slack user: ${slackUser}`);
      }
    }

    logger.info("PR Poker Done!");
  }
  catch (error) {
    logger.error('Error while compiling PR report:', error);
  }
})();
