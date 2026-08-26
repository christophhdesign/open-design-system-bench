// Single-pass @babel/parser + @babel/traverse analysis shared by every
// mechanical grader. Parsing is done once per file and the resulting
// FileAnalysis is reused by imports/api-fidelity/token-discipline/a11y-static
// so we never re-parse the same source.

import { parse } from '@babel/parser';
import type { Node as BabelNode } from '@babel/types';
// @babel/traverse ships as CJS; its ESM default export is wrapped, so the
// real function lives at `.default` when interop doesn't unwrap it for us.
import _traverse from '@babel/traverse';
// Under this repo's tsconfig (nodenext + esModuleInterop) the plain default
// import already works, but we guard for the CJS/ESM interop quirk anyway:
// depending on how the consumer's TS config resolves it, the callable
// function can land on `.default` instead of the binding itself.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const traverse: any = (_traverse as any).default ?? _traverse;

export interface FileAnalysis {
  imports: Array<{ source: string; names: Array<{ imported: string; local: string }> }>;
  jsxElements: Array<{ base: string; full: string; attrs: string[]; hasSpread: boolean; line: number }>;
  classNameLiterals: Array<{ value: string; line: number }>;
  inlineStyles: Array<{ prop: string; value: string; line: number }>;
}

const CLASSNAME_CALL_NAMES = new Set(['cx', 'cn', 'clsx', 'twMerge', 'tv']);

function emptyAnalysis(): FileAnalysis {
  return { imports: [], jsxElements: [], classNameLiterals: [], inlineStyles: [] };
}

function lineOf(node: { loc?: BabelNode['loc'] } | null | undefined): number {
  return node?.loc?.start.line ?? 0;
}

// Leftmost identifier of a (possibly nested) JSXMemberExpression, e.g. `Modal`
// in `Modal.Footer.Item`.
function jsxBaseName(name: any): string {
  if (name.type === 'JSXIdentifier') return name.name;
  if (name.type === 'JSXMemberExpression') return jsxBaseName(name.object);
  if (name.type === 'JSXNamespacedName') return name.namespace.name;
  return '';
}

// Full printed name of a JSX tag name node, e.g. `Modal.Footer`.
function jsxFullName(name: any): string {
  if (name.type === 'JSXIdentifier') return name.name;
  if (name.type === 'JSXMemberExpression') return `${jsxFullName(name.object)}.${name.property.name}`;
  if (name.type === 'JSXNamespacedName') return `${name.namespace.name}:${name.name.name}`;
  return '';
}

function jsxAttrName(name: any): string {
  if (name.type === 'JSXIdentifier') return name.name;
  if (name.type === 'JSXNamespacedName') return `${name.namespace.name}:${name.name.name}`;
  return '';
}

// Collect quasi text chunks of a template literal (cooked text, falling back
// to raw when cooked is unavailable e.g. for tagged-template edge cases).
function templateChunks(tpl: any): string[] {
  return (tpl.quasis ?? []).map((q: any) => q.value?.cooked ?? q.value?.raw ?? '');
}

function stringOrNumberLiteralValue(node: any): string | undefined {
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'NumericLiteral') return String(node.value);
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return templateChunks(node).join('');
  }
  return undefined;
}

export function analyzeSource(path: string, source: string): FileAnalysis {
  let ast;
  try {
    ast = parse(source, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
      errorRecovery: true,
    });
  } catch {
    // Unparseable source (e.g. a non-JS/TSX file swept in by mistake) — the
    // compile grader is the one responsible for surfacing syntax errors, so
    // here we just report "nothing found" rather than throwing.
    return emptyAnalysis();
  }

  const analysis = emptyAnalysis();

  try {
    traverse(ast, {
      ImportDeclaration(p: any) {
        const node = p.node;
        const source = node.source.value as string;
        const names: Array<{ imported: string; local: string }> = [];
        for (const spec of node.specifiers) {
          if (spec.type === 'ImportDefaultSpecifier') {
            names.push({ imported: '__default__', local: spec.local.name });
          } else if (spec.type === 'ImportNamespaceSpecifier') {
            names.push({ imported: '*', local: spec.local.name });
          } else if (spec.type === 'ImportSpecifier') {
            const imported = spec.imported.type === 'Identifier' ? spec.imported.name : spec.imported.value;
            names.push({ imported, local: spec.local.name });
          }
        }
        analysis.imports.push({ source, names });
      },

      JSXOpeningElement(p: any) {
        const node = p.node;
        const base = jsxBaseName(node.name);
        const full = jsxFullName(node.name);
        const attrs: string[] = [];
        let hasSpread = false;
        for (const attr of node.attributes) {
          if (attr.type === 'JSXSpreadAttribute') {
            hasSpread = true;
            continue;
          }
          attrs.push(jsxAttrName(attr.name));
        }
        analysis.jsxElements.push({ base, full, attrs, hasSpread, line: lineOf(node) });

        // className handling on this same opening element.
        const classNameAttr = node.attributes.find(
          (a: any) => a.type === 'JSXAttribute' && jsxAttrName(a.name) === 'className',
        );
        if (classNameAttr?.value) {
          const value = classNameAttr.value;
          if (value.type === 'StringLiteral') {
            analysis.classNameLiterals.push({ value: value.value, line: lineOf(classNameAttr) });
          } else if (value.type === 'JSXExpressionContainer') {
            const expr = value.expression;
            if (expr.type === 'StringLiteral') {
              analysis.classNameLiterals.push({ value: expr.value, line: lineOf(expr) });
            } else if (expr.type === 'TemplateLiteral') {
              for (const chunk of templateChunks(expr)) {
                if (chunk) analysis.classNameLiterals.push({ value: chunk, line: lineOf(expr) });
              }
            }
            // Other expression shapes (identifiers, ternaries feeding cx())
            // are picked up by the CallExpression visitor below when they
            // route through a recognized classname-builder call.
          }
        }

        // style={{ ... }} inline style object.
        const styleAttr = node.attributes.find(
          (a: any) => a.type === 'JSXAttribute' && jsxAttrName(a.name) === 'style',
        );
        if (
          styleAttr?.value?.type === 'JSXExpressionContainer' &&
          styleAttr.value.expression.type === 'ObjectExpression'
        ) {
          for (const prop of styleAttr.value.expression.properties) {
            if (prop.type !== 'ObjectProperty') continue;
            const key = prop.key.type === 'Identifier' ? prop.key.name : prop.key.type === 'StringLiteral' ? prop.key.value : undefined;
            if (!key) continue;
            const val = stringOrNumberLiteralValue(prop.value);
            if (val === undefined) continue;
            analysis.inlineStyles.push({ prop: key, value: val, line: lineOf(prop) });
          }
        }
      },

      CallExpression(p: any) {
        const callee = p.node.callee;
        const calleeName = callee.type === 'Identifier' ? callee.name : undefined;
        if (!calleeName || !CLASSNAME_CALL_NAMES.has(calleeName)) return;
        for (const arg of p.node.arguments) {
          if (arg.type === 'StringLiteral') {
            analysis.classNameLiterals.push({ value: arg.value, line: lineOf(arg) });
          } else if (arg.type === 'TemplateLiteral') {
            for (const chunk of templateChunks(arg)) {
              if (chunk) analysis.classNameLiterals.push({ value: chunk, line: lineOf(arg) });
            }
          }
        }
      },
    });
  } catch {
    // A traverse-time crash (e.g. an AST shape we didn't anticipate) should
    // not take down the whole grading run — fall back to whatever was
    // collected before the failure.
  }

  return analysis;
}
