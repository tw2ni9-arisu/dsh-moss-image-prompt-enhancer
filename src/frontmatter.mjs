/**
 * Minimal YAML frontmatter reader for the bundled SKILL.md.
 *
 * The upstream skill only uses two scalar keys (name, description), so this
 * stays a line scanner instead of pulling in a YAML dependency. The bundled
 * file is validated at load time; a missing or empty field fails loudly.
 */

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;
const SCALAR = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/u;

/**
 * Split a skill document into metadata and body.
 * @param raw - the complete SKILL.md text.
 * @param source - path used in error messages.
 * @returns the parsed name, description, and the body without frontmatter.
 */
export function parseSkillDocument(raw, source) {
  const match = FRONTMATTER.exec(raw);
  if (match === null) throw new Error(`${source} has no YAML frontmatter`);
  const metadata = {};
  for (const line of match[1].split(/\r?\n/u)) {
    const pair = SCALAR.exec(line);
    if (pair !== null) metadata[pair[1]] = pair[2].trim();
  }
  const name = metadata.name;
  const description = metadata.description;
  if (typeof name !== "string" || name.length === 0) throw new Error(`${source} has no name in its frontmatter`);
  if (typeof description !== "string" || description.length === 0) throw new Error(`${source} has no description in its frontmatter`);
  return { name, description, body: raw.slice(match[0].length).trim() };
}
