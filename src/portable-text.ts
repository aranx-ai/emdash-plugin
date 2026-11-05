/**
 * Converts the Aranx article body (`format=json`) to EmDash Portable Text.
 *
 * The Aranx tree uses these tags: h2, h3, p, ul, ol, li, table, thead, tbody,
 * tr, th, td, strong, em, a, blockquote, code, pre, span, div, nav, figure,
 * img. Unknown tags render their children.
 *
 * EmDash headings have no `id`, so the links of the Aranx table of contents
 * (`nav.table-of-contents`) cannot work. The converter drops that block.
 */

export interface ContentNode {
    tag: string;
    attributes?: Record<string, string>;
    children?: (ContentNode | string)[];
}

export interface PortableTextSpan {
    _type: 'span';
    _key: string;
    text: string;
    marks: string[];
}

export interface PortableTextLinkDef {
    _type: 'link';
    _key: string;
    href: string;
    blank?: boolean;
}

export type BlockStyle =
    | 'normal'
    | 'h1'
    | 'h2'
    | 'h3'
    | 'h4'
    | 'h5'
    | 'h6'
    | 'blockquote';

export interface PortableTextTextBlock {
    _type: 'block';
    _key: string;
    style: BlockStyle;
    listItem?: 'bullet' | 'number';
    level?: number;
    children: PortableTextSpan[];
    markDefs: PortableTextLinkDef[];
}

export interface PortableTextImageBlock {
    _type: 'image';
    _key: string;
    asset: { _type: 'reference'; _ref: string; url: string };
    alt?: string;
    caption?: string;
    width?: number;
    height?: number;
}

export interface PortableTextCodeBlock {
    _type: 'code';
    _key: string;
    code: string;
    language?: string;
}

export interface PortableTextTableCell {
    _type: 'tableCell';
    _key: string;
    content: PortableTextSpan[];
    markDefs: PortableTextLinkDef[];
    isHeader?: boolean;
}

export interface PortableTextTableBlock {
    _type: 'table';
    _key: string;
    rows: { _type: 'tableRow'; _key: string; cells: PortableTextTableCell[] }[];
    hasHeaderRow?: boolean;
}

export type PortableTextBlock =
    | PortableTextTextBlock
    | PortableTextImageBlock
    | PortableTextCodeBlock
    | PortableTextTableBlock;

/** Size data that the API returns in `images[]`, matched to body images by URL. */
export interface ImageSize {
    width?: number | null;
    height?: number | null;
}

const HEADING_STYLES: Record<string, BlockStyle> = {
    h1: 'h2',
    h2: 'h2',
    h3: 'h3',
    h4: 'h4',
    h5: 'h5',
    h6: 'h6'
};

const DECORATORS: Record<string, string> = {
    strong: 'strong',
    b: 'strong',
    em: 'em',
    i: 'em',
    code: 'code',
    u: 'underline',
    s: 'strike-through',
    del: 'strike-through',
    sup: 'superscript',
    sub: 'subscript'
};

/** Tags that start a new block. Everything else is inline content. */
const BLOCK_TAGS = new Set([
    'p',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'ul',
    'ol',
    'li',
    'blockquote',
    'pre',
    'table',
    'figure',
    'img',
    'div',
    'nav',
    'section',
    'article',
    'aside',
    'header',
    'footer',
    'hr'
]);

const SAFE_HREF = /^(https?:|mailto:|tel:|#|\/)/i;

function isNode(child: ContentNode | string): child is ContentNode {
    return typeof child !== 'string';
}

function hasClass(node: ContentNode, name: string): boolean {
    return (node.attributes?.class ?? '').split(/\s+/).includes(name);
}

function positiveInt(value: unknown): number | undefined {
    const number = typeof value === 'string' ? Number(value) : value;
    return typeof number === 'number' && Number.isInteger(number) && number > 0
        ? number
        : undefined;
}

function textContent(node: ContentNode | string): string {
    if (typeof node === 'string') return node;
    if (node.tag === 'br') return '\n';
    return (node.children ?? []).map(textContent).join('');
}

class Converter {
    private nextKey = 0;

    constructor(private readonly imageSizes: ReadonlyMap<string, ImageSize>) {}

    key(): string {
        return `k${(this.nextKey++).toString(36)}`;
    }

    /** Converts a list of sibling nodes. Runs of inline nodes become paragraphs. */
    blocks(
        nodes: readonly (ContentNode | string)[],
        out: PortableTextBlock[]
    ): void {
        let inline: (ContentNode | string)[] = [];
        const flush = () => {
            if (inline.length > 0) this.textBlock(inline, 'normal', out);
            inline = [];
        };
        for (const node of nodes) {
            if (isNode(node) && BLOCK_TAGS.has(node.tag)) {
                flush();
                this.block(node, out);
            } else {
                inline.push(node);
            }
        }
        flush();
    }

    private block(node: ContentNode, out: PortableTextBlock[]): void {
        const children = node.children ?? [];
        const heading = HEADING_STYLES[node.tag];
        if (heading) {
            this.textBlock(children, heading, out);
            return;
        }
        switch (node.tag) {
            case 'p':
                // A paragraph that holds an image is split around it.
                if (
                    children.some(
                        (child) => isNode(child) && child.tag === 'img'
                    )
                ) {
                    this.blocks(children, out);
                } else {
                    this.textBlock(children, 'normal', out);
                }
                return;
            case 'ul':
            case 'ol':
                this.list(node, 1, out);
                return;
            case 'li':
                this.textBlock(children, 'normal', out, {
                    listItem: 'bullet',
                    level: 1
                });
                return;
            case 'blockquote': {
                const inner: PortableTextBlock[] = [];
                this.blocks(children, inner);
                for (const block of inner) {
                    if (block._type === 'block' && !block.listItem)
                        block.style = 'blockquote';
                    out.push(block);
                }
                return;
            }
            case 'pre':
                this.code(node, out);
                return;
            case 'table':
                this.table(node, out);
                return;
            case 'figure':
                this.figure(node, out);
                return;
            case 'img':
                this.image(node, undefined, out);
                return;
            case 'nav':
                if (hasClass(node, 'table-of-contents')) return;
                this.blocks(children, out);
                return;
            case 'hr':
                return;
            default:
                this.blocks(children, out);
        }
    }

    private list(
        node: ContentNode,
        level: number,
        out: PortableTextBlock[]
    ): void {
        const listItem = node.tag === 'ol' ? 'number' : 'bullet';
        for (const item of node.children ?? []) {
            if (!isNode(item)) continue;
            if (item.tag === 'ul' || item.tag === 'ol') {
                this.list(item, level + 1, out);
                continue;
            }
            const inline: (ContentNode | string)[] = [];
            const nested: ContentNode[] = [];
            for (const child of item.children ?? []) {
                if (
                    isNode(child) &&
                    (child.tag === 'ul' || child.tag === 'ol')
                ) {
                    nested.push(child);
                } else if (isNode(child) && child.tag === 'p') {
                    if (inline.length > 0) inline.push(' ');
                    inline.push(...(child.children ?? []));
                } else {
                    inline.push(child);
                }
            }
            this.textBlock(inline, 'normal', out, { listItem, level });
            for (const child of nested) this.list(child, level + 1, out);
        }
    }

    private textBlock(
        nodes: readonly (ContentNode | string)[],
        style: BlockStyle,
        out: PortableTextBlock[],
        list?: { listItem: 'bullet' | 'number'; level: number }
    ): void {
        const markDefs: PortableTextLinkDef[] = [];
        const children = this.spans(nodes, markDefs);
        if (children.length === 0) return;
        out.push({
            _type: 'block',
            _key: this.key(),
            style,
            ...list,
            children,
            markDefs
        });
    }

    /** Builds trimmed spans. Adjacent text with the same marks merges. */
    spans(
        nodes: readonly (ContentNode | string)[],
        markDefs: PortableTextLinkDef[]
    ): PortableTextSpan[] {
        const raw: { text: string; marks: string[] }[] = [];
        this.inline(nodes, [], markDefs, raw);

        const spans: PortableTextSpan[] = [];
        for (const piece of raw) {
            const text = piece.text.replace(/[^\S\n]+/g, ' ');
            const last = spans.at(-1);
            if (last && last.marks.join(' ') === piece.marks.join(' ')) {
                last.text += text;
            } else {
                spans.push({
                    _type: 'span',
                    _key: '',
                    text,
                    marks: piece.marks
                });
            }
        }
        // Collapse spaces across span borders, then trim the block edges.
        for (let i = 1; i < spans.length; i++) {
            if (
                spans[i - 1].text.endsWith(' ') &&
                spans[i].text.startsWith(' ')
            ) {
                spans[i].text = spans[i].text.slice(1);
            }
        }
        let kept = spans.filter((span) => span.text.length > 0);
        if (kept.length === 0) return [];
        kept[0].text = kept[0].text.trimStart();
        kept[kept.length - 1].text = kept[kept.length - 1].text.trimEnd();
        kept = kept.filter((span) => span.text.length > 0);
        if (kept.length === 0) return [];

        const usedMarks = new Set(kept.flatMap((span) => span.marks));
        const unused = markDefs.filter((def) => !usedMarks.has(def._key));
        for (const def of unused) markDefs.splice(markDefs.indexOf(def), 1);

        for (const span of kept) span._key = this.key();
        return kept;
    }

    private inline(
        nodes: readonly (ContentNode | string)[],
        marks: string[],
        markDefs: PortableTextLinkDef[],
        out: { text: string; marks: string[] }[]
    ): void {
        for (const node of nodes) {
            if (typeof node === 'string') {
                out.push({ text: node, marks });
                continue;
            }
            if (node.tag === 'br') {
                out.push({ text: '\n', marks });
                continue;
            }
            if (node.tag === 'img') continue;
            const decorator = DECORATORS[node.tag];
            if (decorator) {
                const next = marks.includes(decorator)
                    ? marks
                    : [...marks, decorator];
                this.inline(node.children ?? [], next, markDefs, out);
                continue;
            }
            if (node.tag === 'a') {
                const href = node.attributes?.href?.trim();
                if (href && SAFE_HREF.test(href)) {
                    const def: PortableTextLinkDef = {
                        _type: 'link',
                        _key: this.key(),
                        href
                    };
                    if (node.attributes?.target === '_blank') def.blank = true;
                    markDefs.push(def);
                    this.inline(
                        node.children ?? [],
                        [...marks, def._key],
                        markDefs,
                        out
                    );
                    continue;
                }
            }
            this.inline(node.children ?? [], marks, markDefs, out);
        }
    }

    private code(node: ContentNode, out: PortableTextBlock[]): void {
        const code = textContent(node).replace(/\n$/, '');
        if (!code.trim()) return;
        const codeNode = (node.children ?? []).find(
            (child): child is ContentNode =>
                isNode(child) && child.tag === 'code'
        );
        const language = /(?:^|\s)language-([\w+-]+)/.exec(
            codeNode?.attributes?.class ?? ''
        )?.[1];
        out.push({
            _type: 'code',
            _key: this.key(),
            code,
            ...(language ? { language } : {})
        });
    }

    private figure(node: ContentNode, out: PortableTextBlock[]): void {
        const children = node.children ?? [];
        const caption = children.find(
            (child): child is ContentNode =>
                isNode(child) && child.tag === 'figcaption'
        );
        const captionText = caption
            ? textContent(caption).replace(/\s+/g, ' ').trim()
            : '';
        let found = false;
        for (const child of children) {
            if (!isNode(child) || child === caption) continue;
            if (child.tag === 'img') {
                this.image(child, captionText || undefined, out);
                found = true;
            }
        }
        if (!found)
            this.blocks(
                children.filter((child) => child !== caption),
                out
            );
    }

    private image(
        node: ContentNode,
        caption: string | undefined,
        out: PortableTextBlock[]
    ): void {
        const src = node.attributes?.src?.trim();
        if (!src || !/^https?:\/\//i.test(src)) return;
        const size = this.imageSizes.get(src);
        const width =
            positiveInt(node.attributes?.width) ?? positiveInt(size?.width);
        const height =
            positiveInt(node.attributes?.height) ?? positiveInt(size?.height);
        const alt = node.attributes?.alt?.trim();
        out.push({
            _type: 'image',
            _key: this.key(),
            asset: { _type: 'reference', _ref: src, url: src },
            ...(alt ? { alt } : {}),
            ...(caption ? { caption } : {}),
            ...(width && height ? { width, height } : {})
        });
    }

    private table(node: ContentNode, out: PortableTextBlock[]): void {
        const rows: ContentNode[] = [];
        const collect = (parent: ContentNode) => {
            for (const child of parent.children ?? []) {
                if (!isNode(child)) continue;
                if (child.tag === 'tr') rows.push(child);
                else if (['thead', 'tbody', 'tfoot'].includes(child.tag))
                    collect(child);
            }
        };
        collect(node);

        const tableRows: PortableTextTableBlock['rows'] = [];
        for (const row of rows) {
            const cells: PortableTextTableCell[] = [];
            for (const cell of row.children ?? []) {
                if (!isNode(cell) || (cell.tag !== 'td' && cell.tag !== 'th'))
                    continue;
                const markDefs: PortableTextLinkDef[] = [];
                const content = this.spans(
                    this.flattenBlocks(cell.children ?? []),
                    markDefs
                );
                cells.push({
                    _type: 'tableCell',
                    _key: this.key(),
                    content:
                        content.length > 0
                            ? content
                            : [
                                  {
                                      _type: 'span',
                                      _key: this.key(),
                                      text: '',
                                      marks: []
                                  }
                              ],
                    markDefs,
                    ...(cell.tag === 'th' ? { isHeader: true } : {})
                });
            }
            if (cells.length > 0)
                tableRows.push({ _type: 'tableRow', _key: this.key(), cells });
        }
        if (tableRows.length === 0) return;

        const hasHeaderRow = tableRows[0].cells.every(
            (cell) => cell.isHeader === true
        );
        out.push({
            _type: 'table',
            _key: this.key(),
            rows: tableRows,
            ...(hasHeaderRow ? { hasHeaderRow: true } : {})
        });
    }

    /** Cell content is one line of text. Block children are joined by a space. */
    private flattenBlocks(
        nodes: readonly (ContentNode | string)[]
    ): (ContentNode | string)[] {
        const flat: (ContentNode | string)[] = [];
        for (const node of nodes) {
            if (isNode(node) && BLOCK_TAGS.has(node.tag)) {
                if (flat.length > 0) flat.push(' ');
                flat.push(...this.flattenBlocks(node.children ?? []));
            } else {
                flat.push(node);
            }
        }
        return flat;
    }
}

export function toPortableText(
    content: readonly (ContentNode | string)[],
    imageSizes: ReadonlyMap<string, ImageSize> = new Map()
): PortableTextBlock[] {
    const out: PortableTextBlock[] = [];
    new Converter(imageSizes).blocks(content, out);
    return out;
}

/** Collects the `src` of every image in the body. */
export function bodyImageSources(
    content: readonly (ContentNode | string)[]
): Set<string> {
    const sources = new Set<string>();
    const visit = (node: ContentNode | string) => {
        if (typeof node === 'string') return;
        if (node.tag === 'img' && node.attributes?.src)
            sources.add(node.attributes.src);
        node.children?.forEach(visit);
    };
    content.forEach(visit);
    return sources;
}
