#!/usr/bin/env node
// Releases the package when commits since the last tag ask for it.
// Run by CI on main after the tests pass. Locally, `--dry-run` prints the plan.
//
// 1. Find the last v* tag. Without one, release the version in package.json as is.
// 2. Decide the bump from Conventional Commits since that tag (feat: minor,
//    fix/perf: patch, breaking: major, or minor while at 0.x). No bump, no release.
// 3. Set the version, refresh the
//    lockfile, and add a section to CHANGELOG.md.
// 4. Publish it unless npm already has that version.
// 5. Commit, tag v<version>, push, and create the GitHub release.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { bumpFor, nextVersion, prependSection, renderSection } from "./release-lib.mjs";

const REPO_URL = "https://github.com/appeeky/agentthumbs";
const PACKAGES = ["agentthumbs"];
const dryRun = process.argv.includes("--dry-run");

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", ...opts }).trim();
const run = (cmd, args) => {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  if (!dryRun) execFileSync(cmd, args, { stdio: "inherit" });
};
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

const manifests = PACKAGES.map((dir) => ({ path: `packages/${dir}/package.json`, json: readJson(`packages/${dir}/package.json`) }));
const names = new Set(manifests.map((m) => m.json.name));
const current = manifests.find((m) => m.json.name === "@appeeky/agentthumbs").json.version;

const lastTag = sh("git", ["tag", "--list", "v*", "--sort=-v:refname"]).split("\n").filter(Boolean)[0];
let version;
let commits = [];
if (!lastTag) {
  version = current;
  console.log(`No release tag yet: releasing ${version} as it is.`);
} else {
  const log = sh("git", ["log", `${lastTag}..HEAD`, "--format=%H%x1f%s%x1f%b%x1e"]);
  commits = log.split("\x1e").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const [hash, subject, body = ""] = entry.split("\x1f");
    return { hash, subject, body };
  });
  const bump = bumpFor(commits);
  if (!bump) {
    console.log(`Nothing to release since ${lastTag}: no feat, fix, perf or breaking commits.`);
    process.exit(0);
  }
  version = nextVersion(lastTag.slice(1), bump);
  console.log(`${lastTag} -> v${version} (${bump}, ${commits.length} commits)`);
}

// 3. Versions, lockfile, changelog
if (version !== current) {
  for (const m of manifests) {
    m.json.version = version;
    for (const dep of Object.keys(m.json.dependencies ?? {})) if (names.has(dep)) m.json.dependencies[dep] = version;
    if (!dryRun) writeJson(m.path, m.json);
  }
  run("npm", ["install", "--package-lock-only", "--no-audit", "--no-fund"]);
}
const date = new Date().toISOString().slice(0, 10);
const notes = lastTag ? renderSection(version, date, commits, REPO_URL) : undefined;
if (notes && !dryRun) writeFileSync("CHANGELOG.md", prependSection(readFileSync("CHANGELOG.md", "utf8"), notes));
if (notes) console.log(`\n${notes}`);

// 4. Publish what is missing on npm (a rerun after a partial failure skips the rest).
// A brand-new package's metadata can take minutes to appear, but its tarball is
// served as soon as it is published, so check the tarball too.
async function isPublished(name, ver) {
  try {
    if (sh("npm", ["view", `${name}@${ver}`, "version"], { stdio: ["ignore", "pipe", "ignore"] }) === ver) return true;
  } catch {
    // 404 from the metadata; fall through to the tarball
  }
  const tarball = `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${ver}.tgz`;
  const res = await fetch(tarball, { method: "HEAD" }).catch(() => undefined);
  return res?.ok ?? false;
}

const provenance = process.env.NPM_PROVENANCE === "true" ? ["--provenance"] : [];
for (const dir of PACKAGES) {
  const { name } = readJson(`packages/${dir}/package.json`);
  const published = await isPublished(name, version);
  if (published) console.log(`${name}@${version} is already on npm.`);
  else run("npm", ["publish", "--workspace", `packages/${dir}`, "--access", "public", ...provenance]);
  if (!dryRun) await waitUntilDownloadable(name, version);
}

/**
 * npm takes a few minutes to serve a new version everywhere. Builds that
 * install it right after the release (a dependent's CI, a deploy) would fail
 * with a 404, so the release finishes only once the tarball downloads.
 */
async function waitUntilDownloadable(name, ver, timeoutMs = 15 * 60_000) {
  const tarball = `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${ver}.tgz`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(tarball, { method: "HEAD" }).catch(() => undefined);
    if (res?.ok) return console.log(`${name}@${ver} is downloadable.`);
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
  console.warn(`::warning::${name}@${ver} is not downloadable after ${timeoutMs / 60_000} minutes.`);
}

// 5. Commit, tag, push, GitHub release
const tag = `v${version}`;
if (version !== current || notes) {
  run("git", ["add", "CHANGELOG.md", "package-lock.json", ...manifests.map((m) => m.path)]);
  run("git", ["commit", "-m", `chore(release): ${tag} [skip ci]`]);
}
run("git", ["tag", tag]);
run("git", ["push", "--follow-tags", "origin", "HEAD:main"]);
run("git", ["push", "origin", tag]);
run("gh", ["release", "create", tag, "--title", tag, "--notes", notes ?? `First release on npm.\n\nSee [CHANGELOG.md](${REPO_URL}/blob/main/CHANGELOG.md).`]);
