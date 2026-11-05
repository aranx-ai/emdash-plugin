import { describe, expect, it } from 'vitest';
import {
    bodyImageSources,
    toPortableText,
    type ContentNode
} from '../src/portable-text';

type Node = ContentNode | string;

const IMAGE = 'https://images.aranx.com/w/a/section.webp';

describe('toPortableText', () => {
    it('converts paragraphs with marks and links', () => {
        const content: Node[] = [
            {
                tag: 'p',
                children: [
                    'Intro with ',
                    { tag: 'strong', children: ['bold'] },
                    ' and ',
                    {
                        tag: 'a',
                        attributes: {
                            href: 'https://example.com',
                            target: '_blank',
                            rel: 'nofollow'
                        },
                        children: [{ tag: 'em', children: ['a link'] }]
                    },
                    '.'
                ]
            }
        ];
        const [block] = toPortableText(content);
        expect(block).toMatchObject({
            _type: 'block',
            style: 'normal',
            children: [
                { text: 'Intro with ', marks: [] },
                { text: 'bold', marks: ['strong'] },
                { text: ' and ', marks: [] },
                { text: 'a link', marks: [expect.any(String), 'em'] },
                { text: '.', marks: [] }
            ],
            markDefs: [
                { _type: 'link', href: 'https://example.com', blank: true }
            ]
        });
        if (block._type !== 'block') throw new Error('expected a text block');
        expect(block.children[3].marks[0]).toBe(block.markDefs[0]._key);
    });

    it('maps headings and drops unsafe links', () => {
        const blocks = toPortableText([
            {
                tag: 'h2',
                attributes: { id: 'first' },
                children: ['First section']
            },
            { tag: 'h3', children: ['Detail'] },
            {
                tag: 'p',
                children: [
                    {
                        tag: 'a',
                        attributes: { href: 'javascript:alert(1)' },
                        children: ['x']
                    }
                ]
            }
        ]);
        expect(blocks).toMatchObject([
            { style: 'h2', children: [{ text: 'First section' }] },
            { style: 'h3', children: [{ text: 'Detail' }] },
            {
                style: 'normal',
                children: [{ text: 'x', marks: [] }],
                markDefs: []
            }
        ]);
    });

    it('flattens nested lists with levels', () => {
        const blocks = toPortableText([
            {
                tag: 'ul',
                children: [
                    {
                        tag: 'li',
                        children: [
                            { tag: 'p', children: ['One'] },
                            {
                                tag: 'ol',
                                children: [{ tag: 'li', children: ['One.a'] }]
                            }
                        ]
                    },
                    { tag: 'li', children: ['Two'] }
                ]
            }
        ]);
        expect(blocks).toMatchObject([
            { listItem: 'bullet', level: 1, children: [{ text: 'One' }] },
            { listItem: 'number', level: 2, children: [{ text: 'One.a' }] },
            { listItem: 'bullet', level: 1, children: [{ text: 'Two' }] }
        ]);
    });

    it('converts figures to image blocks with sizes from images[]', () => {
        const blocks = toPortableText(
            [
                {
                    tag: 'figure',
                    attributes: { class: 'article-section-image' },
                    children: [
                        {
                            tag: 'img',
                            attributes: { src: IMAGE, alt: 'A chart' }
                        }
                    ]
                }
            ],
            new Map([[IMAGE, { width: 1600, height: 900 }]])
        );
        expect(blocks).toEqual([
            {
                _type: 'image',
                _key: expect.any(String),
                asset: { _type: 'reference', _ref: IMAGE, url: IMAGE },
                alt: 'A chart',
                width: 1600,
                height: 900
            }
        ]);
    });

    it('converts tables with a header row', () => {
        const [table] = toPortableText([
            {
                tag: 'table',
                children: [
                    {
                        tag: 'thead',
                        children: [
                            {
                                tag: 'tr',
                                children: [
                                    { tag: 'th', children: ['Plan'] },
                                    { tag: 'th', children: ['Price'] }
                                ]
                            }
                        ]
                    },
                    {
                        tag: 'tbody',
                        children: [
                            {
                                tag: 'tr',
                                children: [
                                    {
                                        tag: 'td',
                                        children: [
                                            { tag: 'strong', children: ['Pro'] }
                                        ]
                                    },
                                    {
                                        tag: 'td',
                                        attributes: {
                                            style: 'text-align:right'
                                        },
                                        children: ['$30']
                                    }
                                ]
                            }
                        ]
                    }
                ]
            }
        ]);
        expect(table).toMatchObject({
            _type: 'table',
            hasHeaderRow: true,
            rows: [
                {
                    _type: 'tableRow',
                    cells: [
                        {
                            _type: 'tableCell',
                            isHeader: true,
                            content: [{ text: 'Plan' }]
                        },
                        {
                            _type: 'tableCell',
                            isHeader: true,
                            content: [{ text: 'Price' }]
                        }
                    ]
                },
                {
                    cells: [
                        { content: [{ text: 'Pro', marks: ['strong'] }] },
                        { content: [{ text: '$30' }] }
                    ]
                }
            ]
        });
    });

    it('keeps summary and FAQ content, drops the table of contents', () => {
        const blocks = toPortableText([
            {
                tag: 'div',
                attributes: { class: 'article-summary' },
                children: [{ tag: 'p', children: ['Summary'] }]
            },
            {
                tag: 'nav',
                attributes: { class: 'table-of-contents' },
                children: [
                    {
                        tag: 'ul',
                        children: [
                            {
                                tag: 'li',
                                children: [
                                    {
                                        tag: 'a',
                                        attributes: { href: '#first' },
                                        children: ['First']
                                    }
                                ]
                            }
                        ]
                    }
                ]
            },
            {
                tag: 'div',
                attributes: { class: 'article-faq' },
                children: [
                    { tag: 'h3', children: ['Question?'] },
                    { tag: 'p', children: ['Answer.'] }
                ]
            }
        ]);
        expect(
            blocks.map((block) =>
                block._type === 'block' ? block.children[0].text : block._type
            )
        ).toEqual(['Summary', 'Question?', 'Answer.']);
    });

    it('converts code and blockquotes, and wraps loose text in paragraphs', () => {
        const blocks = toPortableText([
            {
                tag: 'pre',
                children: [
                    {
                        tag: 'code',
                        attributes: { class: 'language-ts' },
                        children: ['const a = 1;\n']
                    }
                ]
            },
            {
                tag: 'blockquote',
                children: [{ tag: 'p', children: ['Quoted'] }]
            },
            {
                tag: 'div',
                children: ['Loose ', { tag: 'code', children: ['text'] }]
            }
        ]);
        expect(blocks).toMatchObject([
            { _type: 'code', code: 'const a = 1;', language: 'ts' },
            {
                _type: 'block',
                style: 'blockquote',
                children: [{ text: 'Quoted' }]
            },
            {
                _type: 'block',
                style: 'normal',
                children: [
                    { text: 'Loose ' },
                    { text: 'text', marks: ['code'] }
                ]
            }
        ]);
    });

    it('collapses whitespace and drops empty blocks', () => {
        const blocks = toPortableText([
            {
                tag: 'p',
                children: [
                    '  Two   spaces ',
                    { tag: 'em', children: [' here '] },
                    ' '
                ]
            },
            { tag: 'p', children: ['   '] }
        ]);
        expect(blocks).toHaveLength(1);
        expect(blocks[0]).toMatchObject({
            children: [
                { text: 'Two spaces ', marks: [] },
                { text: 'here', marks: ['em'] }
            ]
        });
    });

    it('gives every block, span, and mark a unique key', () => {
        const blocks = toPortableText([
            {
                tag: 'p',
                children: [
                    'a',
                    { tag: 'a', attributes: { href: '/x' }, children: ['b'] }
                ]
            },
            { tag: 'p', children: ['c'] }
        ]);
        const keys = blocks.flatMap((block) =>
            block._type === 'block'
                ? [
                      block._key,
                      ...block.children.map((span) => span._key),
                      ...block.markDefs.map((def) => def._key)
                  ]
                : [block._key]
        );
        expect(new Set(keys).size).toBe(keys.length);
    });
});

describe('bodyImageSources', () => {
    it('finds nested images', () => {
        expect(
            bodyImageSources([
                {
                    tag: 'figure',
                    children: [{ tag: 'img', attributes: { src: IMAGE } }]
                }
            ])
        ).toEqual(new Set([IMAGE]));
    });
});
