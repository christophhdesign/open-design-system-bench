// Dimension: a11yStatic (weight .10)
//
// IMPLEMENTATION DECISION: this package has eslint + eslint-plugin-jsx-a11y
// installed, but eslint's own parser (espree) cannot parse TypeScript/TSX,
// and no TS-capable ESLint parser (@typescript-eslint/parser or similar) is
// present in node_modules or package.json. Adding one was explicitly left as
// a "your call" in the spec, but the task's binding constraint is "deps
// installed: ...; do NOT npm install" — so we do not add a dependency here.
// Instead this grader implements a curated, dependency-free subset of
// eslint-plugin-jsx-a11y's checks directly over a @babel/parser +
// @babel/traverse pass (same toolchain as src/grade/ast.ts, but with its own
// traversal since it needs attribute *values*, not just attribute names,
// which the shared FileAnalysis shape deliberately omits for the other
// mechanical graders).
//
// Rules implemented (curated subset, roughly mirroring these jsx-a11y rules):
//   - img-alt                    (alt-text)
//   - no-positive-tabindex       (tabindex-no-positive)
//   - click-without-key          (click-events-have-key-events)
//   - label-has-control          (label-has-associated-control)
//   - control-has-name           (control-has-associated-label + button-has-text)
//   - aria-props                 (aria-props)
//   - no-autofocus               (no-autofocus)
//   - anchor-is-valid            (anchor-is-valid)
//
// control-has-name is the discriminating check. The first seven rules only
// fire on host-element mistakes agents almost never make (bare <img>,
// tabindex={1}, href="#"). Unguided output still ships unlabeled <Toggle>,
// <Switch>, <Input>, and icon-only <IconButton> — and used to score 100.
//
// The component names this grader looks for are conventional defaults that any
// system can extend via SystemConfig.a11y; nothing here is specific to one
// design system.

import { parse } from '@babel/parser';
import type { Node as BabelNode } from '@babel/types';
import _traverse from '@babel/traverse';
// See src/grade/ast.ts for why this indirection is needed (CJS/ESM default
// export interop for @babel/traverse).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const traverse: any = (_traverse as any).default ?? _traverse;

import type { DimensionResult, Diff, Gate, SystemConfig } from '../../types.ts';
import type { GradeContext } from '../context.ts';

const INTERACTIVE_TAGS = new Set([
  'a',
  'button',
  'input',
  'select',
  'textarea',
  'option',
  'summary',
  'audio',
  'video',
]);

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'checkbox',
  'radio',
  'switch',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'tab',
  'textbox',
  'combobox',
  'slider',
  'spinbutton',
]);

// Native form controls that need an accessible name. type=hidden/submit/… are
// skipped at the call site.
const HOST_CONTROLS = new Set(['input', 'select', 'textarea']);

// Conventional form-control names: the ones design systems actually use, plus
// the MUI-shaped names models hallucinate. Every set below is a DEFAULT that a
// system can extend through SystemConfig.a11y, so a library whose text field is
// called something else is not scored against a name it never ships.
const DEFAULT_CONTROLS = [
  'Input',
  'SearchInput',
  'TextField',
  'Select',
  'Toggle',
  'Switch',
  'Checkbox',
  'Radio',
  'Textarea',
];

const DEFAULT_ICON_ONLY = ['IconButton'];

const DEFAULT_LABELS = ['label', 'Label', 'FormLabel'];

// A wrapper that wires label↔control through context counts as associated even
// without an explicit htmlFor.
const DEFAULT_FORM_CONTEXT = ['FormField', 'FormControl', 'label', 'Label'];

/** The resolved per-system vocabulary: conventional defaults plus whatever the system declares. */
interface A11yVocab {
  controls: Set<string>;
  iconOnly: Set<string>;
  labels: Set<string>;
  formContext: Set<string>;
  placeholderNamed: Set<string>;
}

function resolveVocab(cfg: SystemConfig): A11yVocab {
  const a = cfg.a11y ?? {};
  const merge = (defaults: string[], extra: string[] = []) => new Set([...defaults, ...extra]);
  return {
    controls: merge(DEFAULT_CONTROLS, a.controls),
    iconOnly: merge(DEFAULT_ICON_ONLY, a.iconOnly),
    labels: merge(DEFAULT_LABELS, a.labels),
    formContext: merge(DEFAULT_FORM_CONTEXT, a.formContext),
    // No default: placeholder-as-accessible-name is an anti-pattern, honoured
    // only where a system documents it as the contract.
    placeholderNamed: new Set(a.placeholderNamed ?? []),
  };
}

const SKIP_INPUT_TYPES = new Set(['hidden', 'submit', 'reset', 'button', 'image']);

// WAI-ARIA 1.2 global + widget/state attributes (hardcoded; no ARIA spec
// package is installed).
const VALID_ARIA_ATTRS = new Set(
  [
    'activedescendant',
    'atomic',
    'autocomplete',
    'busy',
    'checked',
    'colcount',
    'colindex',
    'colspan',
    'controls',
    'current',
    'describedby',
    'details',
    'disabled',
    'dropeffect',
    'errormessage',
    'expanded',
    'flowto',
    'grabbed',
    'haspopup',
    'hidden',
    'invalid',
    'keyshortcuts',
    'label',
    'labelledby',
    'level',
    'live',
    'modal',
    'multiline',
    'multiselectable',
    'orientation',
    'owns',
    'placeholder',
    'posinset',
    'pressed',
    'readonly',
    'relevant',
    'required',
    'roledescription',
    'rowcount',
    'rowindex',
    'rowspan',
    'selected',
    'setsize',
    'sort',
    'valuemax',
    'valuemin',
    'valuenow',
    'valuetext',
  ].map((s) => `aria-${s}`),
);

function lineOf(node: { loc?: BabelNode['loc'] } | null | undefined): number {
  return node?.loc?.start.line ?? 0;
}

function attrName(name: any): string {
  if (name.type === 'JSXIdentifier') return name.name;
  if (name.type === 'JSXNamespacedName') return `${name.namespace.name}:${name.name.name}`;
  return '';
}

function isHostElement(name: any): name is { type: 'JSXIdentifier'; name: string } {
  return name.type === 'JSXIdentifier' && /^[a-z]/.test(name.name);
}

function jsxTagName(name: any): string {
  if (name.type === 'JSXIdentifier') return name.name;
  if (name.type === 'JSXMemberExpression') return `${jsxTagName(name.object)}.${name.property.name}`;
  if (name.type === 'JSXNamespacedName') return `${name.namespace.name}:${name.name.name}`;
  return '';
}

function findAttr(attributes: any[], name: string): any | undefined {
  return attributes.find((a: any) => a.type === 'JSXAttribute' && attrName(a.name) === name);
}

const UNRESOLVED = Symbol('unresolved');

// Best-effort static value of a JSXAttribute: string, number, boolean
// (shorthand `disabled`), or UNRESOLVED when it's a dynamic expression we
// can't evaluate without running the code.
function staticAttrValue(attr: any): string | number | boolean | typeof UNRESOLVED {
  if (!attr.value) return true; // shorthand boolean attribute
  if (attr.value.type === 'StringLiteral') return attr.value.value;
  if (attr.value.type === 'JSXExpressionContainer') {
    const expr = attr.value.expression;
    if (expr.type === 'StringLiteral') return expr.value;
    if (expr.type === 'NumericLiteral') return expr.value;
    if (expr.type === 'BooleanLiteral') return expr.value;
    if (expr.type === 'UnaryExpression' && expr.operator === '-' && expr.argument.type === 'NumericLiteral') {
      return -expr.argument.value;
    }
  }
  return UNRESOLVED;
}

// Fingerprint an attribute value so `htmlFor={id}` matches `id={id}` and
// `htmlFor={`row-${key}`}` matches `id={`row-${key}`}`. Static strings
// collapse to the same key as a matching literal id.
function attrFingerprint(attr: any): string | undefined {
  if (!attr) return undefined;
  if (!attr.value) return undefined;
  if (attr.value.type === 'StringLiteral') return `lit:${attr.value.value}`;
  if (attr.value.type !== 'JSXExpressionContainer') return undefined;
  return exprFingerprint(attr.value.expression);
}

function exprFingerprint(expr: any): string | undefined {
  if (!expr) return undefined;
  if (expr.type === 'StringLiteral') return `lit:${expr.value}`;
  if (expr.type === 'NumericLiteral') return `lit:${expr.value}`;
  if (expr.type === 'Identifier') return `id:${expr.name}`;
  if (expr.type === 'MemberExpression' && !expr.computed) {
    const object = exprFingerprint(expr.object);
    const prop = expr.property?.type === 'Identifier' ? expr.property.name : undefined;
    if (object && prop) return `mem:${object}.${prop}`;
  }
  if (expr.type === 'TemplateLiteral') {
    const quasis = (expr.quasis ?? []).map((q: any) => q.value?.cooked ?? q.value?.raw ?? '').join('\0');
    const exprs = (expr.expressions ?? []).map((e: any) => exprFingerprint(e) ?? e.type).join(',');
    return `tpl:${quasis}|${exprs}`;
  }
  return undefined;
}

function hasNonEmptyNameAttr(attributes: any[], ...names: string[]): boolean {
  for (const name of names) {
    const attr = findAttr(attributes, name);
    if (!attr) continue;
    const value = staticAttrValue(attr);
    if (value === UNRESOLVED) return true;
    if (typeof value === 'string' && value.trim() !== '') return true;
  }
  return false;
}

function ancestorTagNames(openingPath: any): string[] {
  const tags: string[] = [];
  let parent = openingPath.findParent((p: any) => p.isJSXElement());
  while (parent) {
    tags.push(jsxTagName(parent.node.openingElement.name));
    parent = parent.findParent((p: any) => p.isJSXElement());
  }
  return tags;
}

function elementHasAccessibleText(jsxElement: any): boolean {
  if (!jsxElement?.children) return false;
  for (const child of jsxElement.children) {
    if (child.type === 'JSXText' && child.value.trim() !== '') return true;
    if (child.type === 'JSXExpressionContainer') {
      const expr = child.expression;
      if (expr.type === 'StringLiteral') {
        if (expr.value.trim() !== '') return true;
        continue;
      }
      if (expr.type === 'JSXEmptyExpression') continue;
      if (expr.type === 'NullLiteral' || (expr.type === 'Identifier' && expr.name === 'undefined')) continue;
      if (expr.type === 'BooleanLiteral' && expr.value === false) continue;
      // Dynamic children ({label}, {show ? 'Hide' : 'Show'}) count as a name.
      return true;
    }
    if (child.type === 'JSXElement') {
      const opening = child.openingElement;
      if (hasNonEmptyNameAttr(opening.attributes, 'aria-label', 'aria-labelledby', 'ariaLabel', 'alt')) {
        return true;
      }
      if (elementHasAccessibleText(child)) return true;
    }
  }
  return false;
}

function controlHasAccessibleName(opts: {
  tag: string;
  attributes: any[];
  jsxElement: any;
  ancestors: string[];
  labelledIds: Set<string>;
  vocab: A11yVocab;
}): boolean {
  const { tag, attributes, jsxElement, ancestors, labelledIds, vocab } = opts;

  if (hasNonEmptyNameAttr(attributes, 'aria-label', 'aria-labelledby', 'ariaLabel')) return true;
  // A design-system Checkbox / hallucinated TextField expose a visual `label` prop that
  // becomes the accessible name.
  if (hasNonEmptyNameAttr(attributes, 'label')) return true;

  const idKey = attrFingerprint(findAttr(attributes, 'id'));
  if (idKey && labelledIds.has(idKey)) return true;

  if (ancestors.some((t) => vocab.formContext.has(t) || vocab.labels.has(t))) return true;

  // Only for controls whose own catalog documents placeholder as the name.
  if (vocab.placeholderNamed.has(tag) && hasNonEmptyNameAttr(attributes, 'placeholder')) return true;

  if (tag === 'button' || tag === 'Button' || vocab.iconOnly.has(tag)) {
    return elementHasAccessibleText(jsxElement);
  }

  // Checkbox / Radio with text children (instead of a `label` prop).
  if ((tag === 'Checkbox' || tag === 'Radio') && elementHasAccessibleText(jsxElement)) return true;

  return false;
}

interface A11yError {
  message: string;
  fix?: string;
}

function analyzeFileA11y(path: string, source: string, vocab: A11yVocab): A11yError[] {
  const errors: A11yError[] = [];

  let ast;
  try {
    ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'], errorRecovery: true });
  } catch {
    return errors; // compile.ts is responsible for surfacing syntax errors
  }

  const labelledIds = new Set<string>();
  try {
    traverse(ast, {
      JSXOpeningElement(p: any) {
        const htmlFor = findAttr(p.node.attributes, 'htmlFor');
        const key = attrFingerprint(htmlFor);
        if (key) labelledIds.add(key);
      },
    });
  } catch {
    // Collection pass is best-effort; the main pass still runs.
  }

  try {
    traverse(ast, {
      JSXOpeningElement(p: any) {
        const node = p.node;
        const name = node.name;
        const attributes = node.attributes;
        const line = lineOf(node);
        const tag = jsxTagName(name);
        const jsxElement = p.parentPath?.node?.type === 'JSXElement' ? p.parentPath.node : undefined;

        // no-autofocus: flag on any element, host or component.
        if (findAttr(attributes, 'autoFocus')) {
          errors.push({
            message: `autoFocus on <${tag || 'element'}> in ${path}:${line}`,
            fix: 'Remove autoFocus; it disorients screen-reader and keyboard users.',
          });
        }

        // aria-props: every aria-* attribute name must be a valid ARIA attribute.
        for (const attr of attributes) {
          if (attr.type !== 'JSXAttribute') continue;
          const attrN = attrName(attr.name);
          if (attrN.startsWith('aria-') && !VALID_ARIA_ATTRS.has(attrN)) {
            errors.push({
              message: `Invalid ARIA attribute '${attrN}' in ${path}:${line}`,
              fix: `'${attrN}' is not a valid WAI-ARIA attribute.`,
            });
          }
        }

        if (isHostElement(name)) {
          // img-alt
          if (tag === 'img' && !findAttr(attributes, 'alt')) {
            errors.push({
              message: `<img> missing 'alt' in ${path}:${line}`,
              fix: "Add alt=\"…\" (or alt=\"\" for decorative images).",
            });
          }

          // no-positive-tabindex
          const tabIndexAttr = findAttr(attributes, 'tabIndex');
          if (tabIndexAttr) {
            const value = staticAttrValue(tabIndexAttr);
            if (typeof value === 'number' && value > 0) {
              errors.push({
                message: `Positive tabIndex={${value}} on <${tag}> in ${path}:${line}`,
                fix: 'Use tabIndex={0} or {-1}; positive values break natural tab order.',
              });
            }
          }

          // click-without-key (click-events-have-key-events)
          if (
            findAttr(attributes, 'onClick') &&
            !findAttr(attributes, 'onKeyDown') &&
            !findAttr(attributes, 'onKeyUp') &&
            !findAttr(attributes, 'onKeyPress') &&
            !INTERACTIVE_TAGS.has(tag)
          ) {
            const roleAttr = findAttr(attributes, 'role');
            const role = roleAttr ? staticAttrValue(roleAttr) : undefined;
            const hasInteractiveRole = typeof role === 'string' && INTERACTIVE_ROLES.has(role);
            if (!hasInteractiveRole) {
              errors.push({
                message: `onClick without a keyboard handler on non-interactive <${tag}> in ${path}:${line}`,
                fix: 'Add onKeyDown (Enter/Space) or use a native interactive element like <button>.',
              });
            }
          }

          // anchor-is-valid
          if (tag === 'a') {
            const hrefAttr = findAttr(attributes, 'href');
            if (!hrefAttr) {
              errors.push({
                message: `<a> missing 'href' in ${path}:${line}`,
                fix: 'Add a real href, or use <button> if this is not a navigation link.',
              });
            } else {
              const value = staticAttrValue(hrefAttr);
              if (value === '#' || (typeof value === 'string' && value.startsWith('javascript:'))) {
                errors.push({
                  message: `<a> has a non-navigating href ('${value}') in ${path}:${line}`,
                  fix: 'Use a real href, or use <button> if this is not a navigation link.',
                });
              }
            }
          }
        }

        // control-has-name: unlabeled form controls and nameless icon buttons.
        const inputTypeAttr = findAttr(attributes, 'type');
        const inputType = inputTypeAttr ? staticAttrValue(inputTypeAttr) : undefined;
        const skipHostInput =
          tag === 'input' && typeof inputType === 'string' && SKIP_INPUT_TYPES.has(inputType);

        const isNamableControl =
          (HOST_CONTROLS.has(tag) && !skipHostInput) ||
          vocab.controls.has(tag) ||
          vocab.iconOnly.has(tag) ||
          tag === 'button' ||
          tag === 'Button';

        if (isNamableControl) {
          const ancestors = ancestorTagNames(p);
          if (
            !controlHasAccessibleName({
              vocab,
              tag,
              attributes,
              jsxElement,
              ancestors,
              labelledIds,
            })
          ) {
            const kind = vocab.iconOnly.has(tag) || tag === 'button' || tag === 'Button'
              ? 'icon-only or empty control'
              : 'form control';
            errors.push({
              message: `<${tag}> ${kind} has no accessible name in ${path}:${line}`,
              fix: 'Associate a <label htmlFor> / aria-label, or put the control inside FormField.',
            });
          }
        }
      },

      // label-has-control needs to look at descendants, so it's handled on
      // the full JSXElement rather than just the opening tag.
      JSXElement(p: any) {
        const opening = p.node.openingElement;
        if (!isHostElement(opening.name) || opening.name.name !== 'label') return;
        if (findAttr(opening.attributes, 'htmlFor')) return;

        let hasControl = false;
        p.traverse({
          JSXOpeningElement(inner: any) {
            const n = inner.node.name;
            const innerTag = jsxTagName(n);
            if (
              (n.type === 'JSXIdentifier' && ['input', 'select', 'textarea'].includes(n.name)) ||
              vocab.controls.has(innerTag) ||
              vocab.iconOnly.has(innerTag)
            ) {
              hasControl = true;
            }
          },
        });
        if (!hasControl) {
          errors.push({
            message: `<label> without 'htmlFor' or a nested control in ${path}:${lineOf(p.node)}`,
            fix: 'Add htmlFor={id} pointing at the control, or nest the control inside the <label>.',
          });
        }
      },
    });
  } catch {
    // Traversal crash shouldn't take down the whole grading run.
  }

  return errors;
}

export async function gradeA11yStatic(ctx: GradeContext): Promise<DimensionResult> {
  const vocab = resolveVocab(ctx.systemCfg);
  const diffs: Diff[] = [];
  let errorCount = 0;

  for (const file of ctx.files) {
    const errors = analyzeFileA11y(file.path, file.source, vocab);
    for (const err of errors) {
      errorCount += 1;
      diffs.push({ dimension: 'a11yStatic', message: err.message, fix: err.fix });
    }
  }

  const score = Math.max(0, 100 - errorCount * 15);
  const gate: Gate = errorCount > 0 ? 'review' : 'pass';

  return { dimension: 'a11yStatic', score, gate, diffs };
}
