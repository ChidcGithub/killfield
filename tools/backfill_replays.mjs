#!/usr/bin/env node
/**
 * Backfill the replay archive for records accepted before the board linked
 * to replays.
 *
 * Like reclassify_leaderboard.mjs, it takes already-downloaded GitHub API
 * responses and never touches the network itself. A record is archived only
 * when the Issue's track fingerprints to the committed entry's trackHash —
 * the same identity the verifier recorded — so an Issue edited after it was
 * accepted cannot put a different replay behind a board row.
 *
 * Usage:
 *   gh api --paginate 'repos/OWNER/REPO/issues?state=all&labels=leaderboard&per_page=100' \
 *     | jq -s add > issues.json
 *   gh api 'repos/OWNER/REPO/issues/N/comments?per_page=100' > comments/N.json   # chunked only
 *   node tools/backfill_replays.mjs --issues issues.json --comments comments
 *   node tools/backfill_replays.mjs --issues issues.json --comments comments --write
 *
 * A record verified by hand has no Issue; pass its downloaded JSON with
 * --record FILE (repeatable). It is matched to its entry by trackHash alone.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { unpackSession } from "../viewer/src/replay.js";
import {
  extractSubmission, gatewaySubmitter, replayPathFor, restoreChunkedTrack,
  trackFingerprint, writeArchivedReplay,
} from "./verify_replay.mjs";

const VIEWER = fileURLToPath(new URL("../viewer/", import.meta.url));
const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
};
const issuesPath = argument("--issues");
const commentsDir = argument("--comments");
const boardPath = argument("--board") ?? path.join(VIEWER, "leaderboard.json");
const replayDir = path.join(path.dirname(boardPath), "replays");
const recordPaths = process.argv.flatMap((value, index) => (
  process.argv[index - 1] === "--record" ? [value] : []
));
const write = process.argv.includes("--write");
if (!issuesPath && recordPaths.length === 0) {
  throw new Error("--issues FILE or --record FILE is required");
}
// The workflow's gateway account; chunk comments from anyone else are ignored.
process.env.LEADERBOARD_GATEWAY_AUTHOR ??= "Cichlider";

const issues = issuesPath ? JSON.parse(fs.readFileSync(issuesPath, "utf8")) : [];
const board = JSON.parse(fs.readFileSync(boardPath, "utf8"));
if (!Array.isArray(issues) || !Array.isArray(board.entries)) {
  throw new Error("issues and board must both contain arrays");
}
const byNumber = new Map(issues.map((issue) => [issue.number, issue]));

function commentsFor(number) {
  const file = commentsDir && path.join(commentsDir, `${number}.json`);
  return file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
}

const records = new Map();
for (const file of recordPaths) {
  const submission = JSON.parse(fs.readFileSync(file, "utf8"));
  const session = await unpackSession(submission.track);
  records.set(trackFingerprint(submission, session), submission);
}

let archived = 0;
const missing = [];
for (const entry of board.entries) {
  if (entry.replay && fs.existsSync(path.join(path.dirname(boardPath), entry.replay))) continue;
  const record = records.get(entry.trackHash);
  if (record) {
    if (write) {
      writeArchivedReplay(replayDir, record, entry);
      entry.replay = replayPathFor(entry.trackHash);
    }
    archived += 1;
    continue;
  }
  const issue = byNumber.get(entry.issue);
  if (!issue) {
    missing.push(`${entry.name} (${entry.board}, ${entry.wins} wins): no Issue ${entry.issue}`);
    continue;
  }
  const author = issue.user?.login ?? null;
  const submission = restoreChunkedTrack(
    extractSubmission(issue.body), commentsFor(issue.number),
    gatewaySubmitter(issue.body, author), issue.number,
  );
  const session = await unpackSession(submission.track);
  const trackHash = trackFingerprint(submission, session);
  if (trackHash !== entry.trackHash) {
    throw new Error(`Issue ${issue.number} no longer matches its committed record`);
  }
  if (write) {
    writeArchivedReplay(replayDir, submission, entry);
    entry.replay = replayPathFor(trackHash);
  }
  archived += 1;
}

if (write) fs.writeFileSync(boardPath, `${JSON.stringify(board, null, 2)}\n`);
process.stdout.write(`${write ? "archived" : "would archive"} ${archived} replays\n`);
for (const line of missing) process.stdout.write(`no replay source: ${line}\n`);
