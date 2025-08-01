import dotenv from "dotenv";
import { google, youtube_v3 } from "googleapis";
import Reddit from "reddit";
import moment, { Moment } from "moment";
import { formatNumber, formatYoutubeLink } from "./util";
import { RedditChild, Comment, Verification } from "./types";
import { logger } from "./logger";
import fs, { stat } from "fs";
import path from "path";

dotenv.config();

const SUBREDDIT = process.env["SUBREDDIT"] as string;
const ARTICLE = process.env["SUBREDDIT_ARTICLE"] as string;
const PREVIOUS_DAYS = process.env["PREVIOUS_DAYS"] as string;
const FIRST_TIER_FLAIR_ID = process.env["FIRST_TIER_FLAIR_TEMPLATE_ID"];
const FIRST_TIER_EMOJI_ID = process.env["FIRST_TIER_FLAIR_EMOJI_ID"];
const SECOND_TIER_FLAIR_ID = process.env["SECOND_TIER_FLAIR_TEMPLATE_ID"];
const SECOND_TIER_EMOJI_ID = process.env["SECOND_TIER_FLAIR_EMOJI_ID"];
const MINIMUM_SUB_COUNT = process.env["MINIMUM_SUB_COUNT"] || 100000;
const MINIMUM_VIEW_COUNT = process.env["MINIMUM_VIEW_COUNT"] || 1000000;

const reddit = new Reddit({
  username: process.env["REDDIT_USERNAME"] as string,
  password: process.env["REDDIT_PASSWORD"] as string,
  appId: process.env["REDDIT_APP_ID"] as string,
  appSecret: process.env["REDDIT_APP_SECRET"] as string,
  userAgent: "MyApp/1.0.0 (http://example.com)",
});

const youtube = google.youtube({
  version: "v3",
  auth: process.env["GOOGLE_API_KEY"],
});

const approvedLinks: {
  userId: string;
  commentId: string;
  channelLink: string;
}[] = [];

/**
 * Writes the approved YouTube links to a JSON file
 */
const writeApprovedLinksToFile = () => {
  const filePath = path.join(__dirname, "approved.json");
  const data = {
    lastChecked: new Date().toISOString(),
    approvedLinks,
  };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  logger.info(`Approved links written to ${filePath}`);
};

/**
 * Reads the approved YouTube links from the JSON file
 */
const readApprovedLinksFromFile = () => {
  const filePath = path.join(__dirname, "approved.json");
  if (!fs.existsSync(filePath)) {
    return { lastChecked: null, approvedLinks: [] };
  }
  const data = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(data);
};

/**
 * Updates the flair for the approved channels
 * @param approvedLinks
 */
const updateFlairForApprovedLinks = async (
  approvedLinks: { userId: string; commentId: string; channelLink: string }[]
) => {
  for (const link of approvedLinks) {
    const comment: Comment = {
      author: link.userId,
      created_utc: parseInt(link.commentId),
      youtubeLink: link.channelLink,
      body: "",
      created: 0,
    };
    const verification = await verifyChannel(comment, true);

    if (verification) {
      await setFlair(verification);
    }
  }
};

/**
 * Removes the flair for a specified Reddit user
 * @param username
 */
const removeFlair = async (username: string) => {
  logger.info(`Removing flair for /u/${username}`);
  await reddit.post(`${SUBREDDIT}/api/selectflair`, {
    name: username,
    text: "", // Empty text removes the flair
    flair_template_id: null, // Null template ID removes the flair
  });
};

/**
 * Returns list of top level comments from a Reddit Post (Article)
 * Filters comments that includes YouTube links and created within a date range
 * @param articleSource
 * @param startDate
 */
const getRedditComments = async (articleSource: string, startDate: Moment) => {
  const youtubeLinkReg = /https:\/\/(www\.)?youtube\.com[^\s\[\])(]*/;
  const redditArticle: any[] = await reddit.get(articleSource, { sort: "new" });
  const [, replies] = redditArticle;

  const more = replies.data.children.find(
    (reply: any) => reply.kind === "more"
  );

  if (!more) {
    logger.info("No more comments to load.");
    return [];
  }

  const commentIds = more.data.children;

  const extraComments: any = await reddit.get("/api/morechildren", {
    api_type: "json",
    link_id: `t3_${ARTICLE}`, // Post ID (t3_xxxx)
    children: commentIds.join(","), // Comma-separated list of comment IDs
    limit_children: true,
  });
  //logger.info(`Extra comments: ${JSON.stringify(extraComments)}`);
  const allComments = [
    ...replies.data.children,
    ...extraComments.json.data.things,
  ];

  const comments: Comment[] = allComments
    .filter((child: RedditChild) => child.data.author !== "[deleted]")
    .map((child: RedditChild) => {
      const youtubeLink = !!child.data.body
        ? child.data.body.match(youtubeLinkReg)?.[0] || ""
        : "https://www.youtube.com";
      logger.info(
        `Processing comment by ${child.data.author} with YouTube link: ${youtubeLink}`
      );
      return {
        author: child.data.author,
        body: child.data.body,
        created: child.data.created,
        created_utc: child.data.created_utc,
        youtubeLink: youtubeLink,
      };
    })
    .filter((item: Comment) => {
      const commentCreated = moment.unix(item.created).utc();
      const now = moment.utc();
      return (
        item.youtubeLink?.length && commentCreated.isBetween(startDate, now)
      );
    });

  return comments;
};

/**
 * Looks up a YouTube Channel and validates if Channel is owned by the Reddit author
 * https://developers.google.com/youtube/v3/docs/channels/list
 * @param comment
 */
const verifyChannel = async (
  comment: Comment,
  skipDescriptionCheck = false
): Promise<Verification | undefined> => {
  const usernameReg = new RegExp(`u/${comment.author}`, "i");
  const youtubeChannelListParams: youtube_v3.Params$Resource$Channels$List = {
    part: ["snippet,statistics"],
  };

  if (!comment.youtubeLink) {
    return;
  }

  const formattedYoutubeLink = formatYoutubeLink(
    comment.youtubeLink
      .replace("https://youtube.com", "https://www.youtube.com")
      .replace("https://m.youtube.com", "https://www.youtube.com")
  ).split("?")[0];

  const [, slug] = formattedYoutubeLink.split("https://www.youtube.com/");
  if (!slug) {
    logger.warn(`Invalid YouTube link: ${formattedYoutubeLink}`);
    return;
  }

  logger.info(`Verifying /u/${comment.author} at ${formattedYoutubeLink}`);

  let channelId;

  if (slug.includes("user/")) {
    youtubeChannelListParams.forUsername = slug.split("user/")[1];
  } else if (slug.includes("channel/")) {
    channelId = slug.split("channel/")[1];
  } else if (slug.startsWith("@")) {
    const handle = slug.replace(/^@/, "");
    // @ts-ignore
    youtubeChannelListParams.forHandle = handle;
  } else {
    youtubeChannelListParams.forUsername = slug;
  }

  if (channelId) {
    youtubeChannelListParams.id = [channelId];
  }

  const { data: channel } = await youtube.channels.list(
    youtubeChannelListParams
  );

  if (channel.items) {
    const { snippet, statistics } = channel.items[0];

    if (snippet?.description && statistics) {
      if (usernameReg.test(snippet.description) || skipDescriptionCheck) {
        logger.info(`/u/${comment.author} is verified`);
        approvedLinks.push({
          userId: comment.author,
          commentId: comment.created_utc.toString(),
          channelLink: formattedYoutubeLink,
        });
        return {
          reddit: {
            comment,
          },
          youtube: {
            snippet,
            statistics,
          },
        };
      } else {
        logger.warn(`/u/${comment.author} is NOT verified`);
      }
    }
  } else {
    logger.error(`CHANNEL NOT FOUND`);
  }
};

/**
 * Sets the flair on a specified Reddit author with their subscriberCount and viewCount
 * Applies flair template based on sub and viewer count
 * https://www.reddit.com/dev/api
 * @param verification
 */
const setFlair = async (verification: Verification) => {
  const { author } = verification.reddit.comment;
  const { statistics } = verification.youtube;

  logger.info(`Setting flair for /u/${author}`);

  if (statistics?.subscriberCount && statistics.viewCount) {
    const subCount = +statistics.subscriberCount;
    const viewCount = +statistics.viewCount;
    const flairTemplateId =
      subCount >= +MINIMUM_SUB_COUNT || viewCount >= +MINIMUM_VIEW_COUNT
        ? FIRST_TIER_FLAIR_ID
        : SECOND_TIER_FLAIR_ID;

    const flairEmojiId =
      subCount >= +MINIMUM_SUB_COUNT || viewCount >= +MINIMUM_VIEW_COUNT
        ? FIRST_TIER_EMOJI_ID
        : SECOND_TIER_EMOJI_ID;

    await reddit.post(`${SUBREDDIT}/api/selectflair`, {
      name: author,
      text: `:${flairEmojiId}: Subs: ${formatNumber(
        subCount
      )} Views: ${formatNumber(viewCount)}`,
      flair_template_id: flairTemplateId,
    });
  }
};

async function main() {
  logger.info("Starting script");

  // Read the approved links from the JSON file
  const { lastChecked, approvedLinks: existingApprovedLinks } =
    readApprovedLinksFromFile();
  approvedLinks.push(...existingApprovedLinks);

  // Update flair for the approved links
  await updateFlairForApprovedLinks(existingApprovedLinks);

  const startDate = lastChecked
    ? moment.utc(lastChecked)
    : moment.utc().subtract(PREVIOUS_DAYS, "days");

  logger.info(
    `Retrieving comments from https://www.reddit.com${SUBREDDIT}/comments/${ARTICLE}`
  );
  const comments = await getRedditComments(
    `${SUBREDDIT}/comments/${ARTICLE}`,
    startDate
  );

  if (comments.length === 0) {
    logger.info(`No new valid comments since ${startDate}`);
  } else {
    logger.info(`Reviewing ${comments.length} comments since ${startDate}`);
  }

  for (let i = 0; i < comments.length; i++) {
    const verification = await verifyChannel(comments[i]);

    if (verification) {
      await setFlair(verification);
    }
  }

  //////// writeApprovedLinksToFile();
  logger.info("Script complete");
}

main().catch((e) => {
  logger.fatal(e);
  throw e;
});
