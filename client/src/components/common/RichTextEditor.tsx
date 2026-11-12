import React, { useCallback, useMemo, useState, useEffect, useRef } from 'react';
import {
    createEditor,
    Transforms,
    Descendant,
    Element as SlateElement,
    BaseEditor,
    Editor,
    Text,
} from 'slate';
import {
    Slate,
    Editable,
    withReact,
    ReactEditor,
    RenderElementProps,
    RenderLeafProps,
} from 'slate-react';
import { withHistory, HistoryEditor } from 'slate-history';
import { Dropdown } from 'react-bootstrap';
import Button from './Button';
import { BulletsIcon, ExpandArrowIcon } from '../../icons';
import Label from './Label';

// Define custom types
type CustomText = { text: string; bold?: boolean };
type ParagraphElement = { type: 'paragraph'; dir?: 'ltr' | 'rtl'; children: CustomText[] };
type HeadingElement = { type: 'heading-one' | 'heading-two' | 'heading-three' | 'heading-four'; dir?: 'ltr' | 'rtl'; children: CustomText[] };
type BulletedListElement = { type: 'bulleted-list'; dir?: 'ltr' | 'rtl'; children: ListItemElement[] };
type ListItemElement = { type: 'list-item'; dir?: 'ltr' | 'rtl'; children: CustomText[] };
type CustomElement = ParagraphElement | HeadingElement | BulletedListElement | ListItemElement;

declare module 'slate' {
    interface CustomTypes {
        Editor: BaseEditor & ReactEditor & HistoryEditor;
        Element: CustomElement;
        Text: CustomText;
    }
}

interface RichTextEditorProps {
    value: string;
    onChange: (html: string) => void;
    label?: string;
    placeholder?: string;
    required?: boolean;
}

const RichTextEditor: React.FC<RichTextEditorProps> = ({
    value,
    onChange,
    label,
    placeholder = 'Enter text here...',
    required,
}) => {
    const editor = useMemo(() => withHistory(withReact(createEditor())), []);
    const [editorValue, setEditorValue] = useState<Descendant[]>(initialValue);
    const initialized = useRef(false);

    const renderElement = useCallback((props: RenderElementProps) => <Element {...props} />, []);
    const renderLeaf = useCallback((props: RenderLeafProps) => <Leaf {...props} />, []);

    useEffect(() => {
        if (!initialized.current) {
            if (value.trim().startsWith('<')) {
                setEditorValue(deserializeFromHTML(value));
            } else {
                setEditorValue([{ type: 'paragraph', children: [{ text: value }] }]);
            }
            initialized.current = true;
        }
    }, [value]);

    const handleChange = (newValue: Descendant[]) => {
        setEditorValue(newValue);
        const html = serializeToHTML(newValue);
        onChange(html);
    };

    const toggleLTR = () => {
        if (!editor.selection) {
            ReactEditor.focus(editor);
            Transforms.select(editor, Editor.start(editor, []));
        }

        const [match] = Editor.nodes(editor, {
            match: (n) => SlateElement.isElement(n),
            mode: 'lowest',
        });

        const isLTR = match && SlateElement.isElement(match[0]) && match[0].dir === 'ltr';

        Transforms.setNodes(
            editor,
            { dir: isLTR ? undefined : 'ltr' }, // Remove dir if toggling back to default
            {
                match: (n) => SlateElement.isElement(n),
                at: editor.selection || [],
            }
        );
    };

    const toggleBlock = (format: string) => {
        const isActive = isBlockActive(editor, format);
        Transforms.setNodes(
            editor,
            { type: isActive ? 'paragraph' : format },
            { match: (n) => SlateElement.isElement(n) && n.type !== 'list-item' }
        );
    };

    const toggleBulletList = () => {
        const isActive = isBlockActive(editor, 'bulleted-list');
        Transforms.unwrapNodes(editor, {
            match: (n) => SlateElement.isElement(n) && n.type === 'bulleted-list',
            split: true,
        });
        Transforms.setNodes(editor, { type: isActive ? 'paragraph' : 'list-item' });
        if (!isActive) {
            Transforms.wrapNodes(editor, { type: 'bulleted-list', children: [] });
        }
    };

    return (
        <div>
            {label && (
                <Label htmlFor="richTextEditor" required={required}>
                    {label}
                </Label>
            )}

            <div id="richTextEditor" className="text-editor-output-container border rounded border-color-grey-2 ">
                <div className="height-2-265rem background-color-grey-1 rounded-top border-bottom border-color-grey-2 d-flex align-items-center justify-content-end">
                    <div className="btn-group d-flex flex-row-reverse gap-3">
                        <Dropdown id="dropdown-heading">
                            <Dropdown.Toggle className="bg-transparent pe-0 border-0 d-flex align-items-center justify-content-between">
                                <span className="ps-2 color-grey-3">Text Style</span>
                                <ExpandArrowIcon />
                            </Dropdown.Toggle>
                            <Dropdown.Menu>
                                <Dropdown.Item onClick={() => toggleBlock('paragraph')}>Normal</Dropdown.Item>
                                {/* <Dropdown.Item onClick={() => toggleBlock('heading-one')}>Heading 1</Dropdown.Item>
                                <Dropdown.Item onClick={() => toggleBlock('heading-two')}>Heading 2</Dropdown.Item> */}
                                <Dropdown.Item onClick={() => toggleBlock('heading-three')}>Heading 3</Dropdown.Item>
                                {/* <Dropdown.Item onClick={() => toggleBlock('heading-four')}>Heading 4</Dropdown.Item> */}
                            </Dropdown.Menu>
                        </Dropdown>
                        <Button iconOnlyStyle onClick={toggleBulletList}>
                            <BulletsIcon />
                        </Button>
                        <Button iconOnlyStyle onClick={toggleLTR} className="color-grey-3">
                            LTR
                        </Button>
                    </div>
                </div>

                <Slate editor={editor} initialValue={editorValue} onChange={handleChange} key={JSON.stringify(editorValue)}>
                    <Editable
                        renderElement={renderElement}
                        renderLeaf={renderLeaf}
                        placeholder={placeholder}
                        className="text-editor-output-container px-2 outline-none min-h-100px"
                    />
                </Slate>
            </div>
        </div>
    );
};

const Element = ({ attributes, children, element }: RenderElementProps) => {
    const dir = element.dir || 'rtl'; // Default to 'rtl'
    const className = element.dir ? element.dir : ''; // Add class only if dir is explicitly set

    switch (element.type) {
        case 'heading-one':
            return <h1 {...attributes} className={className} dir={dir}>{children}</h1>;
        case 'heading-two':
            return <h2 {...attributes} className={className} dir={dir}>{children}</h2>;
        case 'heading-three':
            return <h3 {...attributes} className={className} dir={dir}>{children}</h3>;
        case 'heading-four':
            return <h4 {...attributes} className={className} dir={dir}>{children}</h4>;
        case 'bulleted-list':
            return <ul {...attributes} className={className} dir={dir}>{children}</ul>;
        case 'list-item':
            return <li {...attributes} className={className} dir={dir}>{children}</li>;
        default:
            return <p {...attributes} className={`${className}`} dir={dir}>{children}</p>;
    }
};

const Leaf = ({ attributes, children }: RenderLeafProps) => {
    return <span {...attributes}>{children}</span>;
};

const isBlockActive = (editor: Editor, format: string) => {
    const [match] = Array.from(
        Editor.nodes(editor, {
            match: (n) => SlateElement.isElement(n) && n.type === format,
        })
    );
    return !!match;
};

const serializeToHTML = (nodes: Descendant[]): string => {
    const serializeNode = (node: Descendant): string => {
        if (SlateElement.isElement(node)) {
            const dirClass = node.dir && node.dir !== 'rtl' ? ` class="${node.dir}"` : ''; // Only add class for non-default
            switch (node.type) {
                case 'heading-one':
                    return `<h1${dirClass}>${serializeChildren(node.children)}</h1>`;
                case 'heading-two':
                    return `<h2${dirClass}>${serializeChildren(node.children)}</h2>`;
                case 'heading-three':
                    return `<h3${dirClass}>${serializeChildren(node.children)}</h3>`;
                case 'heading-four':
                    return `<h4${dirClass}>${serializeChildren(node.children)}</h4>`;
                case 'bulleted-list':
                    return `<ul${dirClass}>${serializeChildren(node.children)}</ul>`;
                case 'list-item':
                    return `<li${dirClass}>${serializeChildren(node.children)}</li>`;
                default:
                    return `<p${dirClass}>${serializeChildren(node.children)}</p>`;
            }
        } else if (Text.isText(node)) {
            return node.text;
        }
        return '';
    };

    const serializeChildren = (children: Descendant[]): string =>
        children.map(serializeNode).join('');

    return `<div class="text-editor-output-container pb-3">${serializeChildren(nodes)}</div>`;
};

const deserializeFromHTML = (html: string): Descendant[] => {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    if (!doc.body) return [];

    const walk = (node: globalThis.Node): Descendant[] => {
        if (node.nodeType === Node.TEXT_NODE) {
            return [{ text: node.textContent || '' }];
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return [];

        const el = node as HTMLElement;
        const dir = el.className.includes('ltr') ? 'ltr' : el.className.includes('rtl') ? 'rtl' : undefined;

        const children = walkChildren(el);

        // Ensure block elements have at least one text node
        const ensureTextChildren = (children: Descendant[]): Descendant[] => {
            return children.length > 0 ? children : [{ text: '' }];
        };

        switch (el.tagName) {
            case 'H1':
                return [{ type: 'heading-one', dir, children: ensureTextChildren(children) }];
            case 'H2':
                return [{ type: 'heading-two', dir, children: ensureTextChildren(children) }];
            case 'H3':
                return [{ type: 'heading-three', dir, children: ensureTextChildren(children) }];
            case 'H4':
                return [{ type: 'heading-four', dir, children: ensureTextChildren(children) }];
            case 'UL':
                return [{ type: 'bulleted-list', dir, children: ensureTextChildren(children) }];
            case 'LI':
                return [{ type: 'list-item', dir, children: ensureTextChildren(children) }];
            case 'P':
                return [{ type: 'paragraph', dir, children: ensureTextChildren(children) }];
            default:
                return ensureTextChildren(children);
        }
    };

    const walkChildren = (parent: globalThis.Node): Descendant[] => {
        const nodes: Descendant[] = [];
        parent.childNodes.forEach((child) => {
            nodes.push(...walk(child));
        });
        return nodes;
    };

    return walkChildren(doc.body);
};

const initialValue: Descendant[] = [
    {
        type: 'paragraph',
        children: [{ text: '' }],
    },
];

export default RichTextEditor;
