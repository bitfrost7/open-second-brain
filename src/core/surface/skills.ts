/**
 * Skill discovery (Agent Surface Suite).
 *
 * Open Second Brain ships agent skills as `skills/<name>/SKILL.md`
 * inside the plugin checkout; an operator can add vault-local skills
 * under `<vault>/Brain/skills/`. Discovery is read-only and fail-soft:
 * a missing root or an unreadable skill directory yields nothing and
 * never crashes a session. File access inside a skill directory is
 * path-traversal-guarded - agents read skill content, not the host
 * filesystem.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";

import type { FrontmatterValue } from "../types.ts";
import { parseFrontmatter } from "../vault.ts";
import { firstLine } from "./descriptor.ts";

export type SkillErrorCode = "NOT_FOUND" | "INVALID_PATH";

export class SkillError extends Error {
  readonly code: SkillErrorCode;
  constructor(code: SkillErrorCode, message: string) {
    super(message);
    this.name = "SkillError";
    this.code = code;
  }
}

export interface SkillEntry {
  /** Frontmatter `name`, falling back to the directory name. */
  readonly name: string;
  /** Frontmatter `description`, falling back to the first body line. */
  readonly description: string;
  /**
   * Flattened trigger keywords from frontmatter `triggers` field.
   * Empty string when no triggers are declared.
   */
  readonly triggers: string;
  /** Absolute path to the skill directory. */
  readonly path: string;
  /** Absolute path to the SKILL.md file. */
  readonly skillFile: string;
}

export interface SkillRootsOptions {
  /** Plugin checkout root containing `skills/`. */
  readonly repoRoot?: string | null;
  /** Vault root; vault-local skills live at `Brain/skills/`. */
  readonly vault?: string | null;
  /**
   * Explicit skills directory override. When set, the skill surface
   * reads from this path IN ADDITION TO the vault-local `Brain/skills/`
   * path, letting operators extend the skill pool from an external
   * directory (e.g. `~/.hermes/skills/`) without replacing the vault's
   * own skills. Supports ~ expansion via the caller.
   */
  readonly skillsDir?: string | null;
}

export const SKILL_FILE_NAME = "SKILL.md";

/** Existing skill roots. */
export function skillRoots(opts: SkillRootsOptions): string[] {
  const candidates: string[] = [];
  if (opts.repoRoot) candidates.push(join(opts.repoRoot, "skills"));
  if (opts.skillsDir) {
    candidates.push(opts.skillsDir);
  }
  if (opts.vault) {
    candidates.push(join(opts.vault, "Brain", "skills"));
  }
  return candidates.filter((root) => {
    try {
      return statSync(root).isDirectory();
    } catch {
      return false;
    }
  });
}

/**
 * Flatten the frontmatter `triggers` field into a space-separated
 * keyword string. The vault frontmatter parser yields only the two
 * shapes a SKILL.md author can write - a scalar string or an inline
 * array - so those are the cases handled:
 *
 *   triggers: "research lookup 调研"        → "research lookup 调研"
 *   triggers: [research, lookup, 调研]      → "research lookup 调研"
 *
 * A non-string scalar (number/boolean) is not a meaningful keyword
 * source and flattens to the empty string.
 */
function flattenTriggers(raw: FrontmatterValue): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw.join(" ");
  return "";
}

/** Read a skill entry from a path that is known to contain a SKILL.md. */
function readSkillEntryFromPath(skillDir: string): SkillEntry | null {
  const skillFile = join(skillDir, SKILL_FILE_NAME);
  if (!existsSync(skillFile)) return null;
  const [meta, body] = parseFrontmatter(skillFile);
  const metaName = typeof meta["name"] === "string" ? meta["name"].trim() : "";
  const metaDescription = typeof meta["description"] === "string" ? meta["description"].trim() : "";
  const rawTriggers = meta["triggers"];
  const triggers = rawTriggers !== undefined ? flattenTriggers(rawTriggers) : "";
  const dir = basename(skillDir);
  return Object.freeze({
    name: metaName.length > 0 ? metaName : dir,
    description: metaDescription.length > 0 ? metaDescription : firstBodyLine(body),
    triggers,
    path: skillDir,
    skillFile,
  });
}

/** First non-empty, non-heading line of the SKILL.md body. */
function firstBodyLine(body: string): string {
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    return firstLine(trimmed);
  }
  return "";
}

/**
 * Recursively find all directories under `root` that contain a SKILL.md
 * file. A directory that itself has a SKILL.md is treated as a skill
 * root; its subdirectories are NOT searched (skills are leaf nodes).
 * Fail-soft: unreadable directories are skipped.
 */
function findSkillDirs(root: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = join(root, entry);
    let st;
    try {
      st = statSync(fullPath);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const skillFile = join(fullPath, SKILL_FILE_NAME);
    if (existsSync(skillFile)) {
      results.push(fullPath);
    } else {
      // Recurse — this directory is a category namespace, not a skill.
      results.push(...findSkillDirs(fullPath));
    }
  }
  return results;
}

/**
 * Discover skills across roots. A later root overrides an earlier one
 * on name collision (vault-local skills shadow shipped ones). Scans
 * recursively — skills nested under category directories are found.
 * Output is sorted by name. Fail-soft: unreadable roots/directories
 * skip.
 */
export function discoverSkills(roots: ReadonlyArray<string>): SkillEntry[] {
  const byName = new Map<string, SkillEntry>();
  for (const root of roots) {
    const skillDirs = findSkillDirs(root);
    for (const skillDir of skillDirs) {
      try {
        const entry = readSkillEntryFromPath(skillDir);
        if (entry !== null) byName.set(entry.name, entry);
      } catch {
        // One malformed skill never hides the rest.
      }
    }
  }
  return [...byName.values()].toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Read a file inside a skill directory. Default: SKILL.md. A relative
 * `filePath` may name an auxiliary file (reference docs, templates)
 * but can never escape the skill directory.
 */
export function readSkillFile(entry: SkillEntry, filePath?: string): string {
  if (filePath === undefined) return readFileSync(entry.skillFile, "utf8");
  if (isAbsolute(filePath)) {
    throw new SkillError("INVALID_PATH", "skill file path must be relative");
  }
  const abs = resolve(entry.path, filePath);
  if (abs !== entry.path && !abs.startsWith(entry.path + sep)) {
    throw new SkillError("INVALID_PATH", "skill file path must stay inside the skill directory");
  }
  if (!existsSync(abs)) {
    throw new SkillError("NOT_FOUND", `skill file not found: ${filePath}`);
  }
  // Re-check after symlink resolution: a link inside the skill
  // directory must not smuggle reads outside it.
  const realDir = realpathSync(entry.path);
  const realTarget = realpathSync(abs);
  if (realTarget !== realDir && !realTarget.startsWith(realDir + sep)) {
    throw new SkillError("INVALID_PATH", "skill file path must stay inside the skill directory");
  }
  return readFileSync(realTarget, "utf8");
}
