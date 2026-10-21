// ODS triage bot.
//
// Flow for each message posted in ERROR_CHANNEL_ID:
//   1. Claude decides whether it describes a real bug. If not, drop it silently.
//   2. Search the repo's open GitHub issues for duplicates; Claude picks the match.
//   3. Duplicate found  -> DM the reporter a link to the existing issue.
//      No duplicate     -> DM the maintainer a ready-to-copy issue draft.
import {
  AttachmentBuilder,
  Client,
  Events,
  GatewayIntentBits,
  RESTJSONErrorCodes,
} from "discord.js";
import { triageMessage, findDuplicate } from "./llm.js";
import { searchOpenIssues, newIssueUrl } from "./github.js";

const REQUIRED_ENV = [
  "DISCORD_TOKEN",
  "ERROR_CHANNEL_ID",
  "MAINTAINER_USER_ID",
  "ANTHROPIC_API_KEY",
  "GITHUB_REPO",
];
const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Missing environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

const { DISCORD_TOKEN, ERROR_CHANNEL_ID, MAINTAINER_USER_ID, GITHUB_REPO } = process.env;
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

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}; watching channel ${ERROR_CHANNEL_ID}`);
});

client.on(Events.MessageCreate, async (message) => {
  // Ignore ourselves, other bots/webhooks, and every channel but the error channel.
  if (message.author.bot || message.webhookId) return;
  if (message.channelId !== ERROR_CHANNEL_ID) return;

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

  // --- 2. GitHub duplicate check -------------------------------------------
  let duplicate = null;
  let searchFailed = false;
  try {
    const candidates = await searchOpenIssues(GITHUB_REPO, triage.search_query);
    if (candidates.length > 0) {
      const number = await findDuplicate(triage, candidates);
      duplicate = candidates.find((issue) => issue.number === number) ?? null;
    }
  } catch (err) {
    // Don't lose the report if GitHub is down; draft it and flag the failure.
    console.error("[github] Duplicate search failed:", err);
    searchFailed = true;
  }

  // --- 3a. Known issue: thank the reporter ---------------------------------
  if (duplicate) {
    console.log(`[triage] ${message.id} matches #${duplicate.number}`);
    await notifyReporter(message, duplicate);
    return;
  }

  // --- 3b. New issue: send the maintainer a draft --------------------------
  await notifyMaintainer(message, triage, rawText, searchFailed);
}

/** The message text plus links to any attached files (logs, screenshots). */
function buildRawText(message) {
  const parts = [message.content.trim()];
  for (const attachment of message.attachments.values()) {
    parts.push(`[Attachment: ${attachment.name}] ${attachment.url}`);
  }
  return parts.filter(Boolean).join("\n");
}

async function notifyReporter(message, issue) {
  const text =
    `Thanks for reporting this in **#${message.channel.name}**! ` +
    `It's a known issue that we're already tracking here:\n` +
    `**#${issue.number}: ${issue.title}**\n${issue.url}\n\n` +
    `Feel free to add your details or a 👍 on the issue so we can prioritize it.`;

  try {
    await message.author.send(text);
  } catch (err) {
    // The user has DMs from server members turned off; reply in the channel instead.
    if (err.code === RESTJSONErrorCodes.CannotSendMessagesToThisUser) {
      await message.reply({
        content: `This looks like a known issue: **#${issue.number}** ${issue.url} — thanks for the report!`,
        allowedMentions: { repliedUser: false },
      });
    } else {
      throw err;
    }
  }
}

async function notifyMaintainer(message, triage, rawText, searchFailed) {
  const draft = buildIssueDraft(message, triage, rawText);

  const header = [
    `🐞 **New bug report from ${message.author.tag}** — ${message.url}`,
    searchFailed
      ? "⚠️ GitHub search failed, so this was **not** checked for duplicates."
      : "No matching open issue was found.",
  ];
  const prefillUrl = newIssueUrl(GITHUB_REPO, triage.bug_title, draft.body);
  if (prefillUrl.length <= MAX_PREFILL_URL_LENGTH) {
    header.push(`[Open a pre-filled issue on GitHub](<${prefillUrl}>)`);
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
