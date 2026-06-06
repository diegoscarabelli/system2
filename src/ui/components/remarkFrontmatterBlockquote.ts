/**
 * Render document frontmatter as a blockquote of its raw lines, mirroring how the
 * frontmatter is written in the source.
 *
 * `remark-frontmatter` parses the leading `---` block into a `yaml` mdast node (always the
 * first child of the root). Two things go wrong without this transform:
 *   - With `remark-frontmatter` alone, rehype has no handler for `yaml` nodes, so the
 *     frontmatter silently disappears.
 *   - Without `remark-frontmatter` at all, the `---` fence is parsed as a setext heading
 *     underline and the whole `name:`/`description:` block renders as one giant heading.
 *
 * This transform replaces the leading `yaml` node with a `blockquote` whose paragraph holds
 * the original frontmatter lines (plain text, hard-broken between lines) so it reads like the
 * source `key: value` block. Must run after `remark-frontmatter` (which produces the node).
 *
 * Typed structurally to avoid pulling `mdast`/`unified` (pnpm transitive, not direct deps)
 * into this file; the emitted shape is a valid mdast `blockquote`.
 */
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  [key: string]: unknown;
}
interface MdRoot {
  type: 'root';
  children: MdNode[];
}

export function remarkFrontmatterBlockquote() {
  return (tree: MdRoot): void => {
    const node = tree.children[0];
    if (!node || node.type !== 'yaml' || typeof node.value !== 'string') return;

    // `node.value` is the frontmatter body without the `---` fences. Trim trailing
    // whitespace so a trailing newline doesn't produce a blank final line.
    const lines = node.value.replace(/\s+$/, '').split('\n');
    if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) return;

    // Plain text + hard breaks: render each line literally (no markdown interpretation of
    // values) on its own line, matching the single-spaced source layout.
    const paragraph: MdNode = { type: 'paragraph', children: [] };
    lines.forEach((line, i) => {
      if (i > 0) paragraph.children?.push({ type: 'break' });
      paragraph.children?.push({ type: 'text', value: line });
    });

    tree.children[0] = { type: 'blockquote', children: [paragraph] };
  };
}
