// Runs in a package directory before `npm pack` / `npm publish`.
// Copies the root LICENSE into the package, gives it the root
// README with links made absolute and images bundled (npm renders it outside
// the repository), and
// refuses to pack without the compiled iPhone Mirroring helper.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join } from "node:path";

const root = join(process.cwd(), "..", "..");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const repo = "https://github.com/appeeky/agentthumbs";

copyFileSync(join(root, "LICENSE"), "LICENSE");

if (pkg.name === "@appeeky/agentthumbs") {
  // Images ship inside the package and are served from it by jsDelivr, so they
  // show on npm whether or not the repository is public.
  const cdn = `https://cdn.jsdelivr.net/npm/${pkg.name}@${pkg.version}`;
  mkdirSync("assets", { recursive: true });
  const readme = readFileSync(join(root, "README.md"), "utf8")
    .replace(/(src=")(?!https?:)([^"]+)"/g, (_, a, path) => {
      const name = basename(path);
      copyFileSync(join(root, path), join("assets", name));
      return `${a}${cdn}/assets/${name}"`;
    })
    // the CI badge only renders for people who can see the repository
    .replace(/\[!\[CI\]\([^)]*\)\]\([^)]*\)\s*/g, "")
    // markdown links to files or folders in the repo
    .replace(/\]\((?!https?:|#|mailto:)([^)]+)\)/g, (_, path) => `](${repo}/blob/main/${path})`);
  writeFileSync("README.md", readme);
}

if (!existsSync("native/agentthumbs-mirroring")) {
  if (process.platform !== "darwin") {
    console.error("The iPhone Mirroring helper is missing and can only be built on macOS. Publish from a Mac.");
    process.exit(1);
  }
  execFileSync("npm", ["run", "build:helper"], { stdio: "inherit" });
}
