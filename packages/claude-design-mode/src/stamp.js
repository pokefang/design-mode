/**
 * Babel visitor that stamps data-claude-source="relpath:line:col" onto JSX host
 * elements (lowercase tags only). Component call sites are deliberately left
 * unstamped: passing an unknown data attribute as a prop would either get
 * forwarded to an unpredictable host (spread props, Radix asChild) or dropped;
 * component identity comes from the fiber owner chain instead.
 */
export default function stampPlugin({ types: t }) {
  return {
    name: 'design-mode-stamp',
    visitor: {
      JSXOpeningElement(path, state) {
        const name = path.node.name;
        if (name.type !== 'JSXIdentifier') return; // <Foo.Bar>, namespaced: skip
        const first = name.name[0];
        if (first !== first.toLowerCase()) return; // components: skip
        if (!path.node.loc) return;
        const exists = path.node.attributes.some(
          (a) => a.type === 'JSXAttribute' && a.name && a.name.name === 'data-claude-source'
        );
        if (exists) return;
        const { line, column } = path.node.loc.start;
        path.node.attributes.push(
          t.jsxAttribute(
            t.jsxIdentifier('data-claude-source'),
            t.stringLiteral(`${state.opts.relFile}:${line}:${column + 1}`)
          )
        );
      },
    },
  };
}
