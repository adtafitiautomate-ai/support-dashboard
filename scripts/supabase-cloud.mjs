// Pushes migrations (and optionally demo seed data) to the hosted Supabase project.
//
//   npm run db:cloud            → apply migrations
//   npm run db:cloud -- --seed  → apply migrations + demo data (MVNOs, bundles, outlets, demo agents)
//   npm run db:cloud -- --dry   → show what would run
//
// Reads SUPABASE_DB_PASSWORD from .env.cloud (git-ignored) or the environment and
// percent-encodes it, so passwords with special characters just work.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const HOST = "aws-0-eu-west-1.pooler.supabase.com";
const PORT = 5432; // shared session pooler
const USER = "postgres.hpcrwtgmhyxksxxyetbs";

function readEnvFile(path) {
  if (!existsSync(path)) return {};
  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim() && !l.trim().startsWith("#") && l.includes("="))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
      }),
  );
}

const password = process.env.SUPABASE_DB_PASSWORD ?? readEnvFile(".env.cloud").SUPABASE_DB_PASSWORD;
if (!password) {
  console.error("Missing SUPABASE_DB_PASSWORD. Create web/.env.cloud with:\n  SUPABASE_DB_PASSWORD=your-database-password");
  process.exit(1);
}

const url = `postgresql://${USER}:${encodeURIComponent(password)}@${HOST}:${PORT}/postgres`;
const args = ["supabase", "db", "push", "--db-url", url];
if (process.argv.includes("--seed")) args.push("--include-seed");
if (process.argv.includes("--dry")) args.push("--dry-run");

console.log(`→ supabase db push to ${USER}@${HOST}${args.includes("--include-seed") ? " (with seed)" : ""}`);
const r = spawnSync("npx", args, { stdio: "inherit", shell: process.platform === "win32" });
process.exit(r.status ?? 1);
