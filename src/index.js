// ODS triage bot.
//
// Background: the fork (GITHUB_FORK_REPO) is synced from upstream every
// SYNC_INTERVAL_MINUTES, and again whenever a bug report comes in.
//
// Flow for each message posted in ERROR_CHANNEL_ID:
//   1. Claude decides whether it describes a real bug. If not, drop it silently.
//   2. Sync the fork, and search upstream's issues and pull requests; Claude picks the match.
//   3. Match found  -> DM the reporter a link (open issue, fix in progress, or already fixed).
//      No match     -> DM the maintainer a ready-to-copy issue draft.
import {
  AttachmentBuilder,
  Client,
  Events,
  GatewayIntentBits,
  RESTJSONErrorCodes,
} from "discord.js";
import { triageMessage, findDuplicate } from "./llm.js";
import { getUpstreamRepo, searchIssuesAndPulls, newIssueUrl } from "./github.js";
import { startForkSync, syncNow } from "./fork-sync.js";

const REQUIRED_ENV = [
  "DISCORD_TOKEN",
  "ERROR_CHANNEL_ID",
  "MAINTAINER_USER_ID",
  "ANTHROPIC_API_KEY",
  "GITHUB_TOKEN",
  "GITHUB_FORK_REPO",
];
const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Missing environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

const { DISCORD_TOKEN, ERROR_CHANNEL_ID, MAINTAINER_USER_ID, GITHUB_FORK_REPO } = process.env;
const FORK_BRANCH = process.env.FORK_BRANCH || "main";
const SYNC_INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MINUTES || 10) * 60_000;
// Resolved at startup from GITHUB_UPSTREAM_REPO, or from the fork's parent on GitHub.
let upstreamRepo = process.env.GITHUB_UPSTREAM_REPO;

const DISCORD_MESSAGE_LIMIT = 2000;
// GitHub accepts long URLs, but browsers and Discord get unreliable past ~8k chars.
const MAX_PREFILL_URL_LENGTH = 6000;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    // Privileged intent: enable "Message Content Intent" in the Developer Portal.
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, async (c) => {
  upstreamRepo ??= await getUpstreamRepo(GITHUB_FORK_REPO);
  console.log(
    `Logged in as ${c.user.tag}; watching channel ${ERROR_CHANNEL_ID}. ` +
      `Fork ${GITHUB_FORK_REPO}:${FORK_BRANCH} tracks ${upstreamRepo}.`,
  );
  startForkSync(GITHUB_FORK_REPO, FORK_BRANCH, SYNC_INTERVAL_MS, notifySyncStatus);
});

client.on(Events.MessageCreate, async (message) => {
  // Ignore ourselves, other bots/webhooks, and every channel but the error channel.
  if (message.author.bot || message.webhookId) return;
  if (message.channelId !== ERROR_CHANNEL_ID) return;
  if (!upstreamRepo) return; // Still starting up.

  const rawText = buildRawText(message);
  if (!rawText) return;

  try {
    await handleReport(message, rawText);
  } catch (err) {
    console.error(`[triage] Failed to process message ${message.id}:`, err);
  }
});

async function handleReport(message, rawText) {
  // --- 1. AI triage ---------------------------------------------------------
  const triage = await triageMessage(rawText);
  if (!triage?.is_bug) return; // Not a bug (or the model declined): drop silently.
  console.log(`[triage] Bug detected in ${message.id}: ${triage.bug_title}`);

  // --- 2. Sync the fork + search upstream issues and PRs --------------------
  const syncPromise = syncNow(GITHUB_FORK_REPO, FORK_BRANCH);
  let match = null;
  let searchFailed = false;
  try {
    const candidates = await searchIssuesAndPulls(upstreamRepo, triage.search_query);
    if (candidates.length > 0) {
      const number = await findDuplicate(triage, candidates);
      match = candidates.find((item) => item.number === number) ?? null;
    }
  } catch (err) {
    // Don't lose the report if GitHub is down; draft it and flag the failure.
    console.error("[github] Duplicate search failed:", err);
    searchFailed = true;
  }
  const syncResult = await syncPromise;

  // --- 3a. Already known upstream: tell the reporter -----------------------
  if (match) {
    console.log(`[triage] ${message.id} matches ${match.kind} #${match.number} (${match.state})`);
    await notifyReporter(message, match);
    return;
  }

  // --- 3b. New bug: send the maintainer a draft -----------------------------
  await notifyMaintainer(message, triage, rawText, { searchFailed, syncResult });
}

/** The message text plus links to any attached files (logs, screenshots). */
function buildRawText(message) {
  const parts = [message.content.trim()];
  for (const attachment of message.attachments.values()) {
    parts.push(`[Attachment: ${attachment.name}] ${attachment.url}`);
  }
  return parts.filter(Boolean).join("\n");
}

async function notifyReporter(message, match) {
  const link = `**#${match.number}: ${match.title}**\n${match.url}`;
  let text;
  if (match.kind === "pull request" && match.state === "merged") {
    text =
      `Thanks for reporting this! It looks like it's **already fixed** by:\n${link}\n\n` +
      `Updating to the latest version should resolve it. If it still happens after updating, ` +
      `please post again with the new details.`;
  } else if (match.kind === "pull request") {
    text =
      `Thanks for reporting this! A **fix is already in progress** here:\n${link}\n\n` +
      `It should land once that pull request is merged.`;
  } else {
    text =
      `Thanks for reporting this! It's a **known issue** that's already being tracked here:\n${link}\n\n` +
      `Feel free to add your details or a 👍 on the issue so it gets prioritized.`;
  }

  try {
    await message.author.send(text);
  } catch (err) {
    // The user has DMs from server members turned off; reply in the channel instead.
    if (err.code === RESTJSONErrorCodes.CannotSendMessagesToThisUser) {
      await message.reply({
        content: `This is already covered by ${match.kind} **#${match.number}** (${match.state}): ${match.url}`,
        allowedMentions: { repliedUser: false },
      });
    } else {
      throw err;
    }
  }
}

async function notifyMaintainer(message, triage, rawText, { searchFailed, syncResult }) {
  const draft = buildIssueDraft(message, triage, rawText);

  const header = [
    `🐞 **New bug report from ${message.author.tag}** — ${message.url}`,
    searchFailed
      ? `⚠️ GitHub search failed, so this was **not** checked against ${upstreamRepo}.`
      : `No matching issue or pull request found in ${upstreamRepo}.`,
    describeSync(syncResult),
  ];
  const prefillUrl = newIssueUrl(upstreamRepo, triage.bug_title, draft.body);
  if (prefillUrl.length <= MAX_PREFILL_URL_LENGTH) {
    header.push(`[Open a pre-filled issue on ${upstreamRepo}](<${prefillUrl}>)`);
  }

  const maintainer = await client.users.fetch(MAINTAINER_USER_ID);
  const inline = `${header.join("\n")}\n\`\`\`md\n${draft.full}\n\`\`\``;

  // Inline code block when it fits and won't break the fence; otherwise attach a file.
  if (inline.length <= DISCORD_MESSAGE_LIMIT && !draft.full.includes("```")) {
    await maintainer.send(inline);
  } else {
    const file = new AttachmentBuilder(Buffer.from(draft.full, "utf8"), {
      name: "issue-draft.md",
    });
    await maintainer.send({
      content: `${header.join("\n")}\nThe draft is too long for one message, so it's attached.`,
      files: [file],
    });
  }
}

/** One status line about the fork sync that ran alongside this report. */
function describeSync(result) {
  const branch = `\`${GITHUB_FORK_REPO}:${FORK_BRANCH}\``;
  if (!result.ok) {
    return `⚠️ Couldn't sync ${branch} from upstream (${result.message}); your fork may be behind.`;
  }
  if (result.mergeType === "none") {
    return `✅ ${branch} is up to date with upstream.`;
  }
  return `🔄 ${branch} was behind and has just been synced from upstream. Pull locally and retest; it may already be fixed.`;
}

/** DMs the maintainer when background syncing starts failing or recovers. */
async function notifySyncStatus(result) {
  const maintainer = await client.users.fetch(MAINTAINER_USER_ID);
  const branch = `\`${GITHUB_FORK_REPO}:${FORK_BRANCH}\``;
  const text = result.ok
    ? `✅ Fork sync recovered: ${branch} is syncing from ${upstreamRepo} again.`
    : `⚠️ Fork sync failed for ${branch}: ${result.message}\n` +
      (result.status === 409
        ? "Your fork has commits that conflict with upstream. Resolve the conflict manually; I'll keep retrying."
        : "I'll keep retrying and let you know when it recovers.");
  await maintainer.send(text);
}

/**
 * Builds the GitHub issue draft. `body` is what goes in the issue itself;
 * `full` adds the suggested title on top for copy/paste from Discord.
 */
function buildIssueDraft(message, triage, rawText) {
  const fence = fenceFor(rawText);
  const body = [
    triage.issue_body.trim(),
    "",
    "## Raw Error Logs",
    `${fence}text`,
    rawText,
    fence,
    "",
    `_Reported on Discord by \`${message.author.tag}\` in #${message.channel.name}._`,
  ].join("\n");

  return {
    body,
    full: `# ${triage.bug_title}\n\n${body}`,
  };
}

/** A ~~~ fence longer than any run of tildes in `text`, so logs can't break out of it. */
function fenceFor(text) {
  const longest = Math.max(0, ...(text.match(/~+/g) ?? []).map((run) => run.length));
  return "~".repeat(Math.max(3, longest + 1));
}

client.login(DISCORD_TOKEN);
